import { describe, expect, it, vi } from "vitest";
import {
  requestPublic,
  type PublicNetworkDeps,
  type PublicNetworkResponse,
  type ResolvedAddress,
} from "./public-network";

function response(
  status: number,
  headers: PublicNetworkResponse["headers"],
  chunks: string[],
  abort = vi.fn(),
): PublicNetworkResponse {
  return {
    status,
    headers,
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
    })(),
    abort,
  };
}

describe("public network requests", () => {
  it("pins the transport to the validated DNS address and bounds the body", async () => {
    const address = { address: "93.184.216.34", family: 4 };
    const resolve = vi.fn(async () => [address]);
    const transport = vi.fn(async () => response(200, {}, ["safe", " body"]));
    const deps: PublicNetworkDeps = { resolve, transport };

    const result = await requestPublic(
      new URL("https://example.com/article"),
      { timeoutMs: 1000, maxBytes: 16 },
      deps,
    );

    expect(resolve).toHaveBeenCalledWith("example.com");
    expect(transport).toHaveBeenCalledWith(
      expect.any(URL),
      address,
      expect.any(AbortSignal),
      undefined,
    );
    expect(new TextDecoder().decode(result.body)).toBe("safe body");
  });

  it("applies the request timeout while waiting for DNS", async () => {
    const transport = vi.fn(async () => response(200, {}, []));
    const deps: PublicNetworkDeps = {
      resolve: () => new Promise<ResolvedAddress[]>(() => {}),
      transport,
    };

    await expect(
      requestPublic(
        new URL("https://example.com/slow-dns"),
        { timeoutMs: 20, maxBytes: 10 },
        deps,
      ),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("re-resolves every redirect and rejects any private DNS answer", async () => {
    const resolved: Record<string, ResolvedAddress[]> = {
      "example.com": [{ address: "93.184.216.34", family: 4 }],
      "next.example.com": [
        { address: "203.0.113.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    };
    const calls: string[] = [];
    const deps: PublicNetworkDeps = {
      resolve: async (host) => resolved[host] ?? [],
      transport: async (url) => {
        calls.push(url.hostname);
        return response(302, { location: "https://next.example.com/final" }, []);
      },
    };

    await expect(
      requestPublic(
        new URL("https://example.com/start"),
        { timeoutMs: 1000, maxBytes: 10, maxRedirects: 2 },
        deps,
      ),
    ).rejects.toThrow("Endereço local ou privado bloqueado.");
    expect(calls).toEqual(["example.com"]);
  });

  it("rejects an unapproved redirect before resolving or connecting it", async () => {
    const calls: string[] = [];
    const deps: PublicNetworkDeps = {
      resolve: async (host) => {
        calls.push(`dns:${host}`);
        return [{ address: "93.184.216.34", family: 4 }];
      },
      transport: async (url) => {
        calls.push(`http:${url.hostname}`);
        return response(302, { location: "http://127.0.0.1/" }, []);
      },
    };

    await expect(
      requestPublic(
        new URL("https://example.com/start"),
        {
          timeoutMs: 1000,
          maxBytes: 10,
          maxRedirects: 2,
          allowUrl: (url) => url.protocol === "https:",
        },
        deps,
      ),
    ).rejects.toThrow("Public request URL is not approved.");
    expect(calls).toEqual(["dns:example.com", "http:example.com"]);
  });

  it("aborts a response when the streamed body exceeds its byte limit", async () => {
    const abort = vi.fn();
    const deps: PublicNetworkDeps = {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => response(200, {}, ["1234", "5678"], abort),
    };

    await expect(
      requestPublic(
        new URL("https://example.com/large"),
        { timeoutMs: 1000, maxBytes: 6 },
        deps,
      ),
    ).rejects.toThrow("Public response exceeds the size limit.");
    expect(abort).toHaveBeenCalledOnce();
  });
});
