import { unzipSync, strFromU8 } from "fflate";

export type MediumArchiveSignal = "bookmark" | "clap" | "list";
export type MediumArchiveItem = {
  url: string;
  title: string;
  signals: MediumArchiveSignal[];
};
export type MediumArchivePreview = {
  total: number;
  bookmarks: number;
  claps: number;
  listItems: number;
  uniqueArticles: number;
  samples: Array<{ title: string; signals: MediumArchiveSignal[] }>;
};

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_RELEVANT_HTML_BYTES = 25 * 1024 * 1024;

function decodeHtml(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
    (entity, code: string) => {
      if (code[0] === "#") {
        const number =
          code[1].toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10);
        return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
      }
      return (
        (
          {
            amp: "&",
            quot: '"',
            apos: "'",
            lt: "<",
            gt: ">",
            nbsp: " ",
          } as Record<string, string>
        )[code.toLowerCase()] ?? entity
      );
    },
  );
}

function parseLinks(html: string): Array<{ url: string; title: string }> {
  const result: Array<{ url: string; title: string }> = [];
  const anchors = /<a\b([^>]*?)>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(anchors)) {
    const href = match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    try {
      const url = new URL(decodeHtml(href).trim());
      if (
        !["medium.com", "www.medium.com"].includes(
          url.hostname.toLowerCase(),
        ) ||
        !["http:", "https:"].includes(url.protocol)
      )
        continue;
      const pathParts = url.pathname.split("/").filter(Boolean);
      const isStory =
        (pathParts[0] === "p" && Boolean(pathParts[1])) ||
        (pathParts[0]?.startsWith("@") &&
          Boolean(pathParts[1]) &&
          pathParts[1].toLowerCase() !== "list");
      if (!isStory) continue;
      const title = decodeHtml(
        match[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " "),
      ).trim();
      if (title) result.push({ url: url.toString(), title });
    } catch {
      /* Ignore non-article and malformed links in the export. */
    }
  }
  return result;
}

function storyKey(url: string): string {
  const parsed = new URL(url);
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  const id =
    pathParts[0] === "p"
      ? pathParts[1]
      : pathParts.at(-1)?.match(/-([a-f\d]{12,})$/i)?.[1];
  if (id) return `medium-story:${id.toLowerCase()}`;
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "").toLowerCase();
}

export function parseMediumArchive(bytes: Uint8Array): {
  items: MediumArchiveItem[];
  preview: MediumArchivePreview;
} {
  if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES)
    throw new Error("O ZIP está vazio ou excede o limite de 50 MB.");
  const files = unzipSync(bytes, {
    filter: (file) => /^(bookmarks|claps|lists)\/[^/]+\.html$/i.test(file.name),
  });
  const grouped = new Map<string, MediumArchiveItem>();
  let relevantBytes = 0;
  const counts = { bookmarks: 0, claps: 0, listItems: 0 };
  for (const [path, data] of Object.entries(files)) {
    if (
      data.length > MAX_RELEVANT_HTML_BYTES ||
      (relevantBytes += data.length) > MAX_RELEVANT_HTML_BYTES
    )
      throw new Error("Os arquivos de artigos do ZIP excedem 25 MB.");
    const folder = path.split("/")[0].toLowerCase();
    if (folder === "lists" && /reading-list-predefined/i.test(path)) continue;
    const signal: MediumArchiveSignal =
      folder === "bookmarks"
        ? "bookmark"
        : folder === "claps"
          ? "clap"
          : "list";
    for (const { url, title } of parseLinks(strFromU8(data))) {
      if (signal === "bookmark") counts.bookmarks += 1;
      else if (signal === "clap") counts.claps += 1;
      else counts.listItems += 1;
      const key = storyKey(url);
      const existing = grouped.get(key);
      if (existing) {
        if (!existing.signals.includes(signal)) existing.signals.push(signal);
        if (title.length > existing.title.length) existing.title = title;
      } else grouped.set(key, { url, title, signals: [signal] });
    }
  }
  const items = [...grouped.values()];
  return {
    items,
    preview: {
      total: counts.bookmarks + counts.claps + counts.listItems,
      ...counts,
      uniqueArticles: items.length,
      samples: items
        .slice(0, 8)
        .map(({ title, signals }) => ({ title, signals })),
    },
  };
}
