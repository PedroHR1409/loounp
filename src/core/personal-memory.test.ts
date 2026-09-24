import { describe, expect, it } from "vitest";
import {
  activeMemories,
  answerKnowledge,
  knowledgeFor,
  confirm,
  correct,
  discard,
  emptyLedger,
  expirePending,
  forget,
  isCurrentRevision,
  markConflict,
  MemoryConflictError,
  memoryView,
  pendingMemories,
  propose,
  revoke,
} from "./personal-memory";

const now = "2026-09-23T12:00:00.000Z";
const later = "2026-09-23T13:00:00.000Z";

function proposed() {
  return propose(
    emptyLedger(),
    {
      memoryId: "mem_goal00001",
      kind: "goal",
      text: "Quero um portfólio de engenharia de dados com IA",
      origin: "user_declared",
    },
    now,
  );
}

describe("personal memory lifecycle", () => {
  it("keeps a proposal out of the active context until explicitly confirmed (AT-04/05)", () => {
    const ledger = proposed();
    expect(activeMemories(ledger)).toEqual([]);
    expect(pendingMemories(ledger)).toHaveLength(1);
    const confirmed = confirm(ledger, "mem_goal00001", 1, 1, later);
    expect(activeMemories(confirmed).map((memory) => memory.text)).toEqual([
      "Quero um portfólio de engenharia de dados com IA",
    ]);
    expect(confirmed.globalRevision).toBe(ledger.globalRevision + 1);
  });

  it("discarding or ignoring a proposal never enables it", () => {
    const discarded = discard(proposed(), "mem_goal00001", 1);
    expect(activeMemories(discarded)).toEqual([]);
    expect(() => confirm(discarded, "mem_goal00001", 1, 1, later)).toThrow(
      MemoryConflictError,
    );
    const expired = expirePending(proposed(), "2026-11-01T00:00:00.000Z");
    expect(activeMemories(expired)).toEqual([]);
    expect(pendingMemories(expired)).toEqual([]);
  });

  it("a correction stays pending and the previous confirmed text remains until the new revision is approved", () => {
    const confirmed = confirm(proposed(), "mem_goal00001", 1, 1, later);
    const corrected = correct(
      confirmed,
      "mem_goal00001",
      "Quero projetos práticos de dados para o trabalho",
      1,
      later,
    );
    expect(activeMemories(corrected)[0].revision).toBe(1);
    const approved = confirm(corrected, "mem_goal00001", 2, 2, later);
    expect(
      activeMemories(approved).map((memory) => [memory.revision, memory.text]),
    ).toEqual([[2, "Quero projetos práticos de dados para o trabalho"]]);
    expect(
      approved.revisions.find((memory) => memory.revision === 1)?.state,
    ).toBe("superseded");
    expect(
      approved.revisions.find((memory) => memory.revision === 2)?.approvedAt,
    ).toBe(later);
  });

  it("rejects stale expected revisions to avoid confirming text the user did not see", () => {
    const confirmed = confirm(proposed(), "mem_goal00001", 1, 1, later);
    const corrected = correct(
      confirmed,
      "mem_goal00001",
      "Outra redação do objetivo",
      1,
      later,
    );
    expect(() => confirm(corrected, "mem_goal00001", 2, 1, later)).toThrow(
      "mudou",
    );
  });

  it("conflict suspends the current statement until reviewed (AT-06)", () => {
    const confirmed = confirm(proposed(), "mem_goal00001", 1, 1, later);
    const conflicted = markConflict(confirmed, "mem_goal00001", 1);
    expect(activeMemories(conflicted)).toEqual([]);
    expect(memoryView(conflicted)[0].conflicted?.revision).toBe(1);
  });

  it("revocation removes the memory from use and bumps the global revision", () => {
    const confirmed = confirm(proposed(), "mem_goal00001", 1, 1, later);
    const revoked = revoke(confirmed, "mem_goal00001", 1, later);
    expect(activeMemories(revoked)).toEqual([]);
    expect(isCurrentRevision(revoked, "mem_goal00001", 1)).toBe(false);
    expect(revoked.globalRevision).toBe(confirmed.globalRevision + 1);
    expect(() =>
      correct(revoked, "mem_goal00001", "Tentativa de reabrir", 1, later),
    ).toThrow(MemoryConflictError);
  });

  it("forget removes text and revisions leaving only a content-free tombstone", () => {
    const confirmed = confirm(proposed(), "mem_goal00001", 1, 1, later);
    const forgotten = forget(confirmed, "mem_goal00001", later);
    expect(forgotten.revisions).toEqual([]);
    expect(forgotten.tombstones).toEqual([
      { memoryId: "mem_goal00001", forgottenAt: later },
    ]);
    expect(JSON.stringify(forgotten)).not.toContain("portfólio");
    expect(() =>
      propose(
        forgotten,
        {
          memoryId: "mem_goal00001",
          kind: "goal",
          text: "Reuso do identificador",
          origin: "user_declared",
        },
        later,
      ),
    ).toThrow(MemoryConflictError);
  });

  it("validates kind and text size", () => {
    expect(() =>
      propose(
        emptyLedger(),
        {
          memoryId: "mem_bad000001",
          kind: "secret" as never,
          text: "x".repeat(10),
          origin: "user_declared",
        },
        now,
      ),
    ).toThrow("Tipo");
    expect(() =>
      propose(
        emptyLedger(),
        {
          memoryId: "mem_bad000001",
          kind: "goal",
          text: "x".repeat(2000),
          origin: "user_declared",
        },
        now,
      ),
    ).toThrow("caracteres");
  });
});

describe("knowledge memory", () => {
  it("records an unknown term, keeps it active and updates the same memory when the user learns it", () => {
    const unknown = answerKnowledge(
      emptyLedger(),
      { newMemoryId: "mem_know00001", term: "Pydantic", known: false },
      now,
    );
    expect(knowledgeFor(unknown, "pydantic")).toMatchObject({
      memoryId: "mem_know00001",
      known: false,
      text: "Ainda não conhece Pydantic",
    });
    expect(activeMemories(unknown).map((memory) => memory.kind)).toEqual([
      "knowledge",
    ]);
    const learned = answerKnowledge(
      unknown,
      { newMemoryId: "mem_know00002", term: "Pydantic", known: true },
      later,
    );
    expect(knowledgeFor(learned, "Pydantic")).toMatchObject({
      memoryId: "mem_know00001",
      known: true,
      text: "Já conhece Pydantic",
    });
    expect(activeMemories(learned)).toHaveLength(1);
    expect(learned.globalRevision).toBe(2);
    expect(
      answerKnowledge(
        learned,
        { newMemoryId: "mem_know00003", term: "pydantic", known: true },
        later,
      ),
    ).toBe(learned);
  });
});
