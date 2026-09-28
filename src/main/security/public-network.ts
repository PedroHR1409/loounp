import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isPublicAddress } from "./public-address";

export { isPublicAddress } from "./public-address";

export type ResolvedAddress = { address: string; family: number };
export type PublicNetworkResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  abort: () => void;
};
export type PublicNetworkDeps = {
  resolve: (hostname: string) => Promise<ResolvedAddress[]>;
  transport: (
    url: URL,
    address: ResolvedAddress,
    signal: AbortSignal,
    accept?: string,
  ) => Promise<PublicNetworkResponse>;
};

export type PublicRequestOptions = {
  accept?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  allowUrl?: (url: URL) => boolean;
};

export type PublicRequestResult = {
  url: URL;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
};

function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new Error("Public request aborted."));
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Public request aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([pending, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

export async function resolvePublicAddress(
  url: URL,
  deps: Pick<PublicNetworkDeps, "resolve">,
  signal?: AbortSignal,
): Promise<ResolvedAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await withAbort(deps.resolve(hostname), signal);
  if (
    !addresses.length ||
    addresses.some((entry) => !isPublicAddress(entry.address))
  )
    throw new Error("Endereço local ou privado bloqueado.");
  return addresses[0];
}

/** Resolve, validate, pin, and bound a public HTTP response one hop at a time. */
export async function requestPublic(
  start: URL,
  options: PublicRequestOptions,
  deps: PublicNetworkDeps = defaultPublicNetworkDeps,
): Promise<PublicRequestResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error("Invalid public request timeout.");
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    throw new Error("Invalid public response size limit.");
  const maxRedirects = options.maxRedirects ?? 0;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10)
    throw new Error("Invalid public redirect limit.");

  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  let url = new URL(start);
  for (let redirects = 0; ; redirects += 1) {
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      (options.allowUrl && !options.allowUrl(url))
    )
      throw new Error("Public request URL is not approved.");

    const address = await resolvePublicAddress(url, deps, signal);
    const response = await deps.transport(url, address, signal, options.accept);
    if (signal.aborted) {
      response.abort();
      throw signal.reason ?? new Error("Public request aborted.");
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = headerValue(response.headers, "location");
      response.abort();
      if (!location || redirects >= maxRedirects)
        throw new Error("Public request redirect limit exceeded.");
      try {
        url = new URL(location, url);
      } catch {
        throw new Error("Public request returned an invalid redirect.");
      }
      continue;
    }

    const declaredLength = headerValue(response.headers, "content-length");
    if (declaredLength !== undefined) {
      if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > options.maxBytes) {
        response.abort();
        throw new Error("Public response exceeds the size limit.");
      }
    }

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > options.maxBytes)
          throw new Error("Public response exceeds the size limit.");
        chunks.push(chunk);
      }
    } catch (error) {
      response.abort();
      throw error;
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { url, status: response.status, headers: response.headers, body };
  }
}

function headerValue(
  headers: PublicNetworkResponse["headers"],
  name: string,
): string | undefined {
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  return Array.isArray(value) ? value[0] : value;
}

export const defaultPublicNetworkDeps: PublicNetworkDeps = {
  resolve: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  transport: (url, address, signal, accept) =>
    new Promise((resolvePromise, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "GET",
          signal,
          agent: false,
          headers: {
            "user-agent": "Loounp/1.0",
            accept:
              accept ??
              "text/html,application/xhtml+xml,text/plain;q=0.8",
            "accept-encoding": "identity",
          },
          lookup: ((
            _hostname: string,
            options: { all?: boolean },
            callback: (...args: unknown[]) => void,
          ) => {
            if (options?.all)
              callback(null, [
                { address: address.address, family: address.family },
              ]);
            else callback(null, address.address, address.family);
          }) as never,
        },
        (response: IncomingMessage) =>
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: response,
            abort: () => response.destroy(),
          }),
      );
      request.on("error", reject);
      request.end();
    }),
};
