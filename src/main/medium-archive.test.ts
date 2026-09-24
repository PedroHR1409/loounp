import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseMediumArchive } from "./medium-archive";

describe("Medium export parser", () => {
  it("uses only saved, clapped, and custom-list article links and merges duplicate signals", () => {
    const archive = zipSync({
      "bookmarks/bookmarks-0001.html": strToU8(
        '<a href="https://medium.com/@author/agentic-ai-abcdef123456?source=bookmark">Agentic AI &amp; systems</a>',
      ),
      "claps/claps-0001.html": strToU8(
        '<a href="https://medium.com/p/abcdef123456?source=clap">Agentic AI systems</a><a href="https://medium.com/@author/data-tools-456">Data tools</a>',
      ),
      "lists/My-list-0001.html": strToU8(
        '<a href="https://medium.com/@author/data-tools-456">Data tools</a><a href="https://medium.com/@author">Author profile</a><a href="https://medium.com/@author/list/test">List link</a><a href="https://medium.com">Medium home</a>',
      ),
      "lists/Reading-list-predefined.html": strToU8(
        '<a href="https://medium.com/@author/ignored-789">Reading list copy</a>',
      ),
      "sessions/sessions-0001.html": strToU8(
        '<a href="https://medium.com/@author/private-000">Private session</a>',
      ),
      "profile/profile.html": strToU8(
        '<a href="https://medium.com/@author/profile-000">Profile</a>',
      ),
    });
    const { items, preview } = parseMediumArchive(archive);
    expect(items).toHaveLength(2);
    expect(
      items.find((item) => item.signals.includes("bookmark"))?.signals,
    ).toEqual(["bookmark", "clap"]);
    expect(items.find((item) => item.title === "Data tools")?.signals).toEqual([
      "clap",
      "list",
    ]);
    expect(preview).toMatchObject({
      uniqueArticles: 2,
      bookmarks: 1,
      claps: 2,
      listItems: 1,
      total: 4,
    });
    expect(JSON.stringify(items)).not.toContain("Private session");
  });

  it("rejects empty input", () => {
    expect(() => parseMediumArchive(new Uint8Array())).toThrow("vazio");
  });
});
