export type MemoryKind =
  | "goal"
  | "preference"
  | "experience"
  | "constraint"
  | "project_context"
  | "knowledge";
export type MemoryState =
  | "pending"
  | "confirmed"
  | "discarded"
  | "conflicted"
  | "superseded"
  | "revoked";
export type MemoryOrigin = "user_declared" | "interest_profile" | "proposal";

export type MemoryRevision = {
  memoryId: string;
  revision: number;
  kind: MemoryKind;
  text: string;
  origin: MemoryOrigin;
  references: string[];
  state: MemoryState;
  proposedAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
};
export type MemoryTombstone = { memoryId: string; forgottenAt: string };
export type MemoryLedger = {
  globalRevision: number;
  revisions: MemoryRevision[];
  tombstones: MemoryTombstone[];
};

export const memoryKinds: MemoryKind[] = [
  "goal",
  "preference",
  "experience",
  "constraint",
  "project_context",
  "knowledge",
];
export const MAX_MEMORY_TEXT = 1200;
const PENDING_TTL_MS = 30 * 86_400_000;

export class MemoryConflictError extends Error {}

export function emptyLedger(): MemoryLedger {
  return { globalRevision: 0, revisions: [], tombstones: [] };
}

function history(ledger: MemoryLedger, memoryId: string) {
  return ledger.revisions
    .filter((revision) => revision.memoryId === memoryId)
    .sort((a, b) => a.revision - b.revision);
}

export function latestRevision(ledger: MemoryLedger, memoryId: string): number {
  return history(ledger, memoryId).at(-1)?.revision ?? 0;
}

function assertExpected(
  ledger: MemoryLedger,
  memoryId: string,
  expectedRevision: number,
) {
  const latest = latestRevision(ledger, memoryId);
  if (latest === 0) throw new MemoryConflictError("Memória não encontrada.");
  if (latest !== expectedRevision)
    throw new MemoryConflictError(
      "A memória mudou desde que foi exibida. Revise a versão atual.",
    );
}

function normalizeText(text: string) {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length < 3 || value.length > MAX_MEMORY_TEXT)
    throw new Error(
      `A memória deve ter entre 3 e ${MAX_MEMORY_TEXT} caracteres.`,
    );
  return value;
}

function replace(
  ledger: MemoryLedger,
  updated: MemoryRevision[],
  bump: boolean,
): MemoryLedger {
  const keys = new Set(
    updated.map((revision) => `${revision.memoryId}#${revision.revision}`),
  );
  return {
    ...ledger,
    globalRevision: ledger.globalRevision + (bump ? 1 : 0),
    revisions: [
      ...ledger.revisions.filter(
        (revision) => !keys.has(`${revision.memoryId}#${revision.revision}`),
      ),
      ...updated,
    ],
  };
}

export function propose(
  ledger: MemoryLedger,
  input: {
    memoryId: string;
    kind: MemoryKind;
    text: string;
    origin: MemoryOrigin;
    references?: string[];
  },
  now: string,
): MemoryLedger {
  if (!memoryKinds.includes(input.kind))
    throw new Error("Tipo de memória inválido.");
  if (
    ledger.tombstones.some(
      (tombstone) => tombstone.memoryId === input.memoryId,
    ) ||
    latestRevision(ledger, input.memoryId)
  )
    throw new MemoryConflictError("Identificador de memória já utilizado.");
  const text = normalizeText(input.text);
  const duplicate = ledger.revisions.find(
    (revision) =>
      revision.text.toLowerCase() === text.toLowerCase() &&
      (revision.state === "pending" || revision.state === "confirmed"),
  );
  if (duplicate)
    throw new MemoryConflictError("Já existe uma memória com esse texto.");
  const revision: MemoryRevision = {
    memoryId: input.memoryId,
    revision: 1,
    kind: input.kind,
    text,
    origin: input.origin,
    references: (input.references ?? []).slice(0, 10),
    state: "pending",
    proposedAt: now,
    approvedAt: null,
    revokedAt: null,
  };
  return replace(ledger, [revision], false);
}

export function correct(
  ledger: MemoryLedger,
  memoryId: string,
  text: string,
  expectedRevision: number,
  now: string,
): MemoryLedger {
  assertExpected(ledger, memoryId, expectedRevision);
  const revisions = history(ledger, memoryId);
  const latest = revisions.at(-1)!;
  if (
    latest.state === "revoked" ||
    (latest.state === "discarded" &&
      !revisions.some(
        (revision) =>
          revision.state === "confirmed" || revision.state === "conflicted",
      ))
  )
    throw new MemoryConflictError("Memória encerrada não pode ser corrigida.");
  const staleProposals = revisions
    .filter((revision) => revision.state === "pending")
    .map((revision) => ({ ...revision, state: "discarded" as const }));
  const next: MemoryRevision = {
    ...latest,
    revision: latest.revision + 1,
    text: normalizeText(text),
    origin: "user_declared",
    state: "pending",
    proposedAt: now,
    approvedAt: null,
    revokedAt: null,
  };
  return replace(ledger, [...staleProposals, next], false);
}

export function confirm(
  ledger: MemoryLedger,
  memoryId: string,
  revision: number,
  expectedRevision: number,
  now: string,
): MemoryLedger {
  assertExpected(ledger, memoryId, expectedRevision);
  const revisions = history(ledger, memoryId);
  const target = revisions.find((candidate) => candidate.revision === revision);
  if (!target || target.state !== "pending")
    throw new MemoryConflictError(
      "Somente uma revisão pendente exibida pode ser confirmada.",
    );
  const superseded = revisions
    .filter(
      (candidate) =>
        candidate.revision !== revision &&
        (candidate.state === "confirmed" || candidate.state === "conflicted"),
    )
    .map((candidate) => ({ ...candidate, state: "superseded" as const }));
  return replace(
    ledger,
    [...superseded, { ...target, state: "confirmed", approvedAt: now }],
    true,
  );
}

export function discard(
  ledger: MemoryLedger,
  memoryId: string,
  expectedRevision: number,
): MemoryLedger {
  assertExpected(ledger, memoryId, expectedRevision);
  const pending = history(ledger, memoryId).filter(
    (revision) => revision.state === "pending",
  );
  if (!pending.length)
    throw new MemoryConflictError("Não há proposta pendente para descartar.");
  return replace(
    ledger,
    pending.map((revision) => ({ ...revision, state: "discarded" as const })),
    false,
  );
}

export function markConflict(
  ledger: MemoryLedger,
  memoryId: string,
  expectedRevision: number,
): MemoryLedger {
  assertExpected(ledger, memoryId, expectedRevision);
  const current = history(ledger, memoryId).find(
    (revision) => revision.state === "confirmed",
  );
  if (!current)
    throw new MemoryConflictError(
      "Não há afirmação confirmada para suspender.",
    );
  return replace(ledger, [{ ...current, state: "conflicted" }], true);
}

export function revoke(
  ledger: MemoryLedger,
  memoryId: string,
  expectedRevision: number,
  now: string,
): MemoryLedger {
  assertExpected(ledger, memoryId, expectedRevision);
  const updated = history(ledger, memoryId).flatMap(
    (revision): MemoryRevision[] => {
      if (revision.state === "confirmed" || revision.state === "conflicted")
        return [{ ...revision, state: "revoked", revokedAt: now }];
      if (revision.state === "pending")
        return [{ ...revision, state: "discarded" }];
      return [];
    },
  );
  if (!updated.length)
    throw new MemoryConflictError("Nada a revogar nesta memória.");
  return replace(ledger, updated, true);
}

export function forget(
  ledger: MemoryLedger,
  memoryId: string,
  now: string,
): MemoryLedger {
  if (!latestRevision(ledger, memoryId))
    throw new MemoryConflictError("Memória não encontrada.");
  return {
    globalRevision: ledger.globalRevision + 1,
    revisions: ledger.revisions.filter(
      (revision) => revision.memoryId !== memoryId,
    ),
    tombstones: [...ledger.tombstones, { memoryId, forgottenAt: now }],
  };
}

export function activeMemories(ledger: MemoryLedger): MemoryRevision[] {
  return ledger.revisions
    .filter((revision) => revision.state === "confirmed")
    .sort((a, b) => a.memoryId.localeCompare(b.memoryId));
}

export function pendingMemories(ledger: MemoryLedger): MemoryRevision[] {
  return ledger.revisions.filter((revision) => revision.state === "pending");
}

export function expirePending(ledger: MemoryLedger, now: string): MemoryLedger {
  const cutoff = Date.parse(now) - PENDING_TTL_MS;
  const expired = ledger.revisions.filter(
    (revision) =>
      revision.state === "pending" && Date.parse(revision.proposedAt) < cutoff,
  );
  return expired.length
    ? replace(
        ledger,
        expired.map((revision) => ({
          ...revision,
          state: "discarded" as const,
        })),
        false,
      )
    : ledger;
}

export function isCurrentRevision(
  ledger: MemoryLedger,
  memoryId: string,
  revision: number,
): boolean {
  return ledger.revisions.some(
    (candidate) =>
      candidate.memoryId === memoryId &&
      candidate.revision === revision &&
      candidate.state === "confirmed",
  );
}

export function termKey(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .trim();
}

export function knowledgeText(term: string, known: boolean) {
  return known ? `Já conhece ${term}` : `Ainda não conhece ${term}`;
}

export function knowledgeFor(
  ledger: MemoryLedger,
  term: string,
): {
  memoryId: string;
  revision: number;
  latestRevision: number;
  known: boolean;
  text: string;
} | null {
  const reference = `term:${termKey(term)}`;
  const current = ledger.revisions.find(
    (revision) =>
      revision.kind === "knowledge" &&
      revision.state === "confirmed" &&
      revision.references.includes(reference),
  );
  if (!current) return null;
  return {
    memoryId: current.memoryId,
    revision: current.revision,
    latestRevision: latestRevision(ledger, current.memoryId),
    known: current.text.startsWith("Já conhece"),
    text: current.text,
  };
}

export function answerKnowledge(
  ledger: MemoryLedger,
  input: { newMemoryId: string; term: string; known: boolean },
  now: string,
): MemoryLedger {
  const term = input.term.replace(/\s+/g, " ").trim();
  if (!termKey(term)) throw new Error("Termo inválido.");
  const text = knowledgeText(term, input.known);
  const existing = knowledgeFor(ledger, term);
  if (existing) {
    if (existing.known === input.known) return ledger;
    const corrected = correct(
      ledger,
      existing.memoryId,
      text,
      existing.latestRevision,
      now,
    );
    const next = latestRevision(corrected, existing.memoryId);
    return confirm(corrected, existing.memoryId, next, next, now);
  }
  const cleared = ledger.revisions.filter(
    (revision) =>
      revision.state === "pending" &&
      revision.text.toLowerCase() === text.toLowerCase(),
  );
  const base = cleared.length
    ? replace(
        ledger,
        cleared.map((revision) => ({
          ...revision,
          state: "discarded" as const,
        })),
        false,
      )
    : ledger;
  const proposed = propose(
    base,
    {
      memoryId: input.newMemoryId,
      kind: "knowledge",
      text,
      origin: "user_declared",
      references: [`term:${termKey(term)}`],
    },
    now,
  );
  return confirm(proposed, input.newMemoryId, 1, 1, now);
}

export function memoryView(ledger: MemoryLedger) {
  const ids = [
    ...new Set(ledger.revisions.map((revision) => revision.memoryId)),
  ];
  return ids
    .map((memoryId) => {
      const revisions = history(ledger, memoryId);
      return {
        memoryId,
        latestRevision: revisions.at(-1)!.revision,
        confirmed:
          revisions.find((revision) => revision.state === "confirmed") ?? null,
        conflicted:
          revisions.find((revision) => revision.state === "conflicted") ?? null,
        pending:
          revisions.find((revision) => revision.state === "pending") ?? null,
        revoked:
          revisions.some((revision) => revision.state === "revoked") &&
          !revisions.some(
            (revision) =>
              revision.state === "confirmed" || revision.state === "pending",
          ),
      };
    })
    .filter(
      (view) =>
        view.confirmed || view.conflicted || view.pending || view.revoked,
    );
}
