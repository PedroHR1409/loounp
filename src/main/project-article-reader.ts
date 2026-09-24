import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomBytes } from "node:crypto";
import {
  limits,
  type ArticleOrigin,
  type ArticleSnapshot,
  type Coverage,
} from "../core/project-ideas";

export class ArticleFetchError extends Error {}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["100::", 64],
  ["2001::", 32],
  ["::", 96],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = lower.match(
    /(?:^::ffff:|^64:ff9b::|^::)(\d+\.\d+\.\d+\.\d+)$/,
  );
  if (dotted) return dotted[1];
  const hex = lower.match(
    /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  if (sixToFour) {
    const high = parseInt(sixToFour[1], 16);
    const low = parseInt(sixToFour[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return null;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const inner = embeddedIpv4(address);
  if (inner) return isPublicAddress(inner);
  return !blocked.check(address, "ipv6");
}

export type TransportResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  abort: () => void;
};
export type ArticleReaderDeps = {
  resolve: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: number }>>;
  transport: (
    url: URL,
    address: { address: string; family: number },
    signal: AbortSignal,
  ) => Promise<TransportResponse>;
  now: () => Date;
};

export const defaultReaderDeps: ArticleReaderDeps = {
  resolve: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  transport: (url, address, signal) =>
    new Promise((resolvePromise, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "GET",
          signal,
          agent: false,
          headers: {
            "user-agent": "RadarArticleReader/1.0",
            accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
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
  now: () => new Date(),
};

function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArticleFetchError("URL inválida.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new ArticleFetchError(
      "Somente endereços HTTP(S) públicos são aceitos.",
    );
  if (url.username || url.password)
    throw new ArticleFetchError("URLs com credenciais não são aceitas.");
  if (url.port && !["80", "443"].includes(url.port))
    throw new ArticleFetchError("Porta não permitida para leitura de artigos.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  )
    throw new ArticleFetchError("Endereço local ou privado bloqueado.");
  url.hash = "";
  return url;
}

async function resolvePublic(url: URL, deps: ArticleReaderDeps) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await deps.resolve(hostname);
  if (
    !addresses.length ||
    addresses.some((entry) => !isPublicAddress(entry.address))
  )
    throw new ArticleFetchError("Endereço local ou privado bloqueado.");
  return addresses[0];
}

export async function fetchPublicDocument(
  rawUrl: string,
  deps: ArticleReaderDeps = defaultReaderDeps,
  signal?: AbortSignal,
): Promise<{ url: URL; contentType: string; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.article.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let url = validateUrl(rawUrl);
    for (let redirects = 0; ; redirects += 1) {
      const address = await resolvePublic(url, deps);
      const response = await deps.transport(url, address, controller.signal);
      if (response.status >= 300 && response.status < 400) {
        response.abort();
        const location = response.headers.location;
        if (
          typeof location !== "string" ||
          redirects >= limits.article.maxRedirects
        )
          throw new ArticleFetchError(
            "Redirecionamentos excessivos ou inválidos.",
          );
        url = validateUrl(new URL(location, url).toString());
        continue;
      }
      if (response.status !== 200) {
        response.abort();
        throw new ArticleFetchError(
          `A página respondeu com status ${response.status}.`,
        );
      }
      const contentType = String(
        response.headers["content-type"] ?? "",
      ).toLowerCase();
      if (
        !/^(text\/html|application\/xhtml\+xml|text\/plain)/.test(contentType)
      ) {
        response.abort();
        throw new ArticleFetchError("Conteúdo não é uma página de texto.");
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (declared > limits.article.maxResponseBytes) {
        response.abort();
        throw new ArticleFetchError("Página excede o limite de 5 MiB.");
      }
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const part of response.body) {
        size += part.length;
        if (size > limits.article.maxResponseBytes) {
          response.abort();
          throw new ArticleFetchError("Página excede o limite de 5 MiB.");
        }
        parts.push(part);
      }
      return { url, contentType, body: Buffer.concat(parts).toString("utf8") };
    }
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof ArticleFetchError))
      throw new ArticleFetchError(
        signal?.aborted
          ? "Leitura cancelada."
          : "A página não respondeu em 20 segundos.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};
function decodeEntities(value: string) {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : "";
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

function metaContent(html: string, key: string) {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`,
    "i",
  );
  const tag = html.match(pattern)?.[0];
  return tag
    ? decodeEntities(tag.match(/content=["']([^"']*)["']/i)?.[1] ?? "").trim()
    : "";
}

const PAYWALL =
  /(member-only story|this story is only available|sign up to read|subscribe to (continue|read)|already a subscriber|paywall|metered-?content)/i;

export function extractArticle(html: string): {
  title: string;
  text: string;
  description: string;
  paywall: boolean;
} {
  const title =
    metaContent(html, "og:title") ||
    decodeEntities(
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
    ).trim();
  const description =
    metaContent(html, "og:description") || metaContent(html, "description");
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|button|figure)\b[\s\S]*?<\/\1>/gi,
      " ",
    );
  const region =
    cleaned.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ??
    cleaned.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ??
    cleaned.match(/<body\b[\s\S]*?<\/body>/i)?.[0] ??
    cleaned;
  const text = decodeEntities(
    region
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|pre|blockquote|section|tr)>/gi, "\n")
      .replace(
        /<h([1-6])[^>]*>/gi,
        (_match, level: string) => `\n${"#".repeat(Number(level))} `,
      )
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title: title.slice(0, 300),
    text,
    description: description.slice(0, 1000),
    paywall: PAYWALL.test(html),
  };
}

function snapshot(
  origin: ArticleOrigin,
  title: string,
  text: string,
  coverage: Coverage,
  limitations: string[],
  now: Date,
): ArticleSnapshot {
  return {
    id: `art_${randomBytes(9).toString("base64url")}`,
    origin,
    title: title || "Artigo sem título",
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    coverage,
    limitations,
    capturedAt: now.toISOString(),
  };
}

export function snapshotFromHtml(
  html: string,
  origin: ArticleOrigin,
  now: Date,
  fallbackTitle = "",
): ArticleSnapshot {
  const extracted = extractArticle(html);
  const title = extracted.title || fallbackTitle;
  const limitations: string[] = [
    "Corpo extraído automaticamente; não há verificação de completude editorial.",
  ];
  if (extracted.text.length < limits.article.minMainTextChars) {
    const text = [title, extracted.description].filter(Boolean).join("\n\n");
    return snapshot(
      origin,
      title,
      text,
      "metadata_only",
      [
        "Somente título e descrição públicos estavam disponíveis.",
        "Metadados não sustentam uma recomendação detalhada; cole o texto do artigo se tiver acesso.",
      ],
      now,
    );
  }
  let text = extracted.text;
  let coverage: Coverage = "main_text";
  if (extracted.paywall) {
    coverage = "partial";
    limitations.push(
      "A página indica conteúdo restrito a assinantes; o texto pode estar incompleto.",
    );
  }
  if (text.length > limits.article.maxTextChars) {
    text = text.slice(0, limits.article.maxTextChars);
    coverage = "partial";
    limitations.push(
      `Texto truncado em ${limits.article.maxTextChars.toLocaleString("pt-BR")} caracteres.`,
    );
  }
  return snapshot(origin, title, text, coverage, limitations, now);
}

export function snapshotFromUserText(
  text: string,
  title: string,
  origin: ArticleOrigin,
  now: Date,
): ArticleSnapshot {
  const trimmed = text.trim().slice(0, limits.article.maxTextChars);
  const limitations = [
    "Texto fornecido pelo usuário; não comprova acesso à página completa.",
  ];
  if (text.trim().length > limits.article.maxTextChars)
    limitations.push(
      `Texto truncado em ${limits.article.maxTextChars.toLocaleString("pt-BR")} caracteres.`,
    );
  return snapshot(origin, title.trim(), trimmed, "user_text", limitations, now);
}

export async function readArticle(
  url: string,
  origin: ArticleOrigin,
  deps: ArticleReaderDeps = defaultReaderDeps,
  signal?: AbortSignal,
  fallbackTitle = "",
): Promise<ArticleSnapshot> {
  const document = await fetchPublicDocument(url, deps, signal);
  if (document.contentType.startsWith("text/plain")) {
    const text = document.body.slice(0, limits.article.maxTextChars);
    return snapshot(
      origin,
      fallbackTitle,
      text,
      text.length >= limits.article.minMainTextChars
        ? "main_text"
        : "metadata_only",
      ["Texto simples recebido da página."],
      deps.now(),
    );
  }
  return snapshotFromHtml(document.body, origin, deps.now(), fallbackTitle);
}
