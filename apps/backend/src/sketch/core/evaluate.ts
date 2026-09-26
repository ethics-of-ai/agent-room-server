import { sha256Hex } from "../../util/hash";
import {
  SKETCH_HISTORY_BYTE_BUDGET,
  SKETCH_MAX_BATCH_BYTES,
  SKETCH_MAX_DOCUMENT_BYTES,
  SKETCH_MAX_EXPIRED_REQUEST_IDS,
  SKETCH_MAX_RETAINED_RECEIPTS,
  SKETCH_MAX_UNDO_ENTRIES,
  SKETCH_SCHEMA_VERSION
} from "./limits";
import {
  sketchCommitRequestSchema,
  sketchDocumentSchema,
  sketchIdSchema,
  sketchUndoRedoRequestSchema,
  type SketchActor,
  type SketchState,
  type SketchReceipt,
  type SketchOperation
} from "./schemas";
import type { SketchCoreError } from "./errors";
import { measureSketchDocumentBytes } from "./document";
import { applyOperations } from "./operations";
import type { ZodError } from "zod";

// The deterministic sketch transaction evaluator: one implementation of edit
// semantics shared by humans and agents, with no server, renderer, or runner
// process involved. Everything here is a pure function of
// (state, request) -> (state, receipt) | error — the caller owns persistence
// and authority, and a refusal leaves the caller's state untouched because a
// refusal never returns new state at all.
//
// Three rules are load-bearing:
//
// - **Batches are all-or-nothing.** Operations apply sequentially to a
//   working clone; the first inapplicable one fails the whole request with
//   its index, and the caller's state is the same object it passed in.
// - **Undo compensates, never restores a snapshot.** Every committed
//   transaction stores the exact inverse operations that retract it. Undo
//   applies the head entry's inverses as a fresh transaction and shuttles
//   that entry to the redo stack; redo shuttles it back applying its
//   forwards. A new ordinary commit clears the redo stack, which is what
//   makes an earlier action ineligible until intervening edits are undone.
// - **Authorship is caller-trusted, model-never.** The actor descriptor
//   arrives per request; B03 derives it from authenticated callers and
//   runner bindings. No operation payload can carry an author.

export type SketchTransactionResult =
  | {
      ok: true;
      state: SketchState;
      receipt: SketchReceipt;
      undoDepth: number;
      redoDepth: number;
    }
  | { ok: false; error: SketchCoreError };

export function createSketchState(sketchId: string): SketchState {
  const parsed = sketchIdSchema.safeParse(sketchId);
  if (!parsed.success) {
    throw new TypeError(`Invalid sketch id: ${parsed.error.issues[0]?.message ?? sketchId}`);
  }
  return {
    schemaVersion: SKETCH_SCHEMA_VERSION,
    sketchId,
    document: {
      schemaVersion: SKETCH_SCHEMA_VERSION,
      kind: "sketch",
      sketchId,
      revision: 0,
      objects: []
    },
    history: { undo: [], redo: [] },
    receipts: [],
    expiredRequestIds: []
  };
}

export function evaluateSketchCommit(state: SketchState, request: unknown): SketchTransactionResult {
  const parsed = sketchCommitRequestSchema.safeParse(request);
  if (!parsed.success) {
    return { ok: false, error: invalidRequestError(parsed.error) };
  }
  const commit = parsed.data;
  const fingerprint = commitFingerprint(commit);

  const replay = replayReceipt(state, commit.requestId, fingerprint);
  if (replay !== undefined) {
    return replay;
  }
  const stale = checkStaleRevision(state, commit.baseRevision);
  if (stale !== undefined) {
    return { ok: false, error: stale };
  }

  const batchBytes = Buffer.byteLength(JSON.stringify(commit.operations));
  if (batchBytes > SKETCH_MAX_BATCH_BYTES) {
    return {
      ok: false,
      error: {
        code: "limit_exceeded",
        limit: "batchBytes",
        message: `A batch may serialize to at most ${SKETCH_MAX_BATCH_BYTES} bytes (got ${batchBytes})`
      }
    };
  }

  const working: SketchState = structuredClone(state);
  const applied = applyOperations(working.document, commit.operations);
  if (!applied.ok) {
    return { ok: false, error: applied.error };
  }

  return finalizeTransaction(working, {
    kind: "commit",
    actor: commit.actor,
    turnId: commit.turnId,
    label: commit.label ?? `${commit.operations.length} operation(s)`,
    forwardOps: commit.operations,
    inverseOps: applied.ops,
    requestId: commit.requestId,
    fingerprint,
    createHistoryEntry: true
  });
}

export function undoSketchTransaction(
  state: SketchState,
  request: unknown
): SketchTransactionResult {
  const parsed = sketchUndoRedoRequestSchema.safeParse(request);
  if (!parsed.success) {
    return { ok: false, error: invalidRequestError(parsed.error) };
  }
  const undoRequest = parsed.data;
  const fingerprint = undoRedoFingerprint("undo", undoRequest);

  const replay = replayReceipt(state, undoRequest.requestId, fingerprint);
  if (replay !== undefined) {
    return replay;
  }
  const stale = checkStaleRevision(state, undoRequest.baseRevision);
  if (stale !== undefined) {
    return { ok: false, error: stale };
  }
  if (state.history.undo.length === 0) {
    return { ok: false, error: { code: "nothing_to_undo", message: "Nothing to undo" } };
  }

  const working: SketchState = structuredClone(state);
  const head = working.history.undo.pop();
  if (head === undefined) {
    return { ok: false, error: { code: "nothing_to_undo", message: "Nothing to undo" } };
  }
  const applied = applyOperations(working.document, head.inverseOps);
  if (!applied.ok) {
    // Stored inverses apply cleanly on a head-consistent state; a failure
    // here means tampered history, surfaced as a refusal rather than a
    // partial undo.
    return { ok: false, error: applied.error };
  }

  const result = finalizeTransaction(working, {
    kind: "undo",
    actor: undoRequest.actor,
    turnId: undoRequest.turnId,
    label: undoRequest.label ?? `Undo "${head.label}"`,
    forwardOps: head.inverseOps,
    inverseOps: head.forwardOps,
    requestId: undoRequest.requestId,
    fingerprint,
    createHistoryEntry: false
  });
  if (result.ok) {
    result.state.history.redo.push(head);
    trimHistory(result.state.history);
    result.redoDepth = result.state.history.redo.length;
  }
  return result;
}

export function redoSketchTransaction(
  state: SketchState,
  request: unknown
): SketchTransactionResult {
  const parsed = sketchUndoRedoRequestSchema.safeParse(request);
  if (!parsed.success) {
    return { ok: false, error: invalidRequestError(parsed.error) };
  }
  const redoRequest = parsed.data;
  const fingerprint = undoRedoFingerprint("redo", redoRequest);

  const replay = replayReceipt(state, redoRequest.requestId, fingerprint);
  if (replay !== undefined) {
    return replay;
  }
  const stale = checkStaleRevision(state, redoRequest.baseRevision);
  if (stale !== undefined) {
    return { ok: false, error: stale };
  }
  if (state.history.redo.length === 0) {
    return { ok: false, error: { code: "nothing_to_redo", message: "Nothing to redo" } };
  }

  const working: SketchState = structuredClone(state);
  const head = working.history.redo.pop();
  if (head === undefined) {
    return { ok: false, error: { code: "nothing_to_redo", message: "Nothing to redo" } };
  }
  const applied = applyOperations(working.document, head.forwardOps);
  if (!applied.ok) {
    return { ok: false, error: applied.error };
  }

  const result = finalizeTransaction(working, {
    kind: "redo",
    actor: redoRequest.actor,
    turnId: redoRequest.turnId,
    label: redoRequest.label ?? `Redo "${head.label}"`,
    forwardOps: head.forwardOps,
    inverseOps: head.inverseOps,
    requestId: redoRequest.requestId,
    fingerprint,
    createHistoryEntry: false
  });
  if (result.ok) {
    result.state.history.undo.push(head);
    trimHistory(result.state.history);
    result.undoDepth = result.state.history.undo.length;
  }
  return result;
}

// --- transaction finalization --------------------------------------------------

interface PendingTransaction {
  kind: SketchReceipt["kind"];
  actor: SketchActor;
  turnId?: string;
  label: string;
  forwardOps: SketchOperation[];
  inverseOps: SketchOperation[];
  requestId: string;
  fingerprint: string;
  // Commit transactions append a history entry. Undo and redo never do: the
  // popped entry itself shuttles between the stacks, which is what keeps the
  // linear head-only semantics exact.
  createHistoryEntry: boolean;
}

function finalizeTransaction(
  working: SketchState,
  pending: PendingTransaction
): SketchTransactionResult {
  const net = sketchDocumentSchema.safeParse(working.document);
  if (!net.success) {
    // Every operation checked its own applicability and invariants, so an
    // invalid result means this module broke its own contract. Throwing
    // routes the blame to a 500 instead of telling the caller their edit was
    // at fault — the same discipline as the diagram edit evaluator.
    const issue = net.error.issues[0];
    throw new Error(
      `sketch evaluation produced an invalid document: ${issue?.message ?? "unknown issue"}`
    );
  }

  const documentBytes = measureSketchDocumentBytes(working.document);
  if (documentBytes > SKETCH_MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      error: {
        code: "limit_exceeded",
        limit: "documentBytes",
        message: `A sketch document may serialize to at most ${SKETCH_MAX_DOCUMENT_BYTES} bytes (got ${documentBytes})`
      }
    };
  }

  working.document.revision += 1;
  const transactionId = `tx-${working.document.revision}`;
  const receipt: SketchReceipt = {
    requestId: pending.requestId,
    transactionId,
    revision: working.document.revision,
    kind: pending.kind,
    actor: pending.actor,
    ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
    label: pending.label,
    requestFingerprint: pending.fingerprint
  };

  if (pending.createHistoryEntry) {
    working.history.undo.push({
      transactionId,
      revision: working.document.revision,
      actor: pending.actor,
      ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
      label: pending.label,
      forwardOps: pending.forwardOps,
      inverseOps: pending.inverseOps
    });
    working.history.redo = [];
  }
  trimHistory(working.history);

  working.receipts.push(receipt);
  if (working.receipts.length > SKETCH_MAX_RETAINED_RECEIPTS) {
    const evicted = working.receipts.splice(0, working.receipts.length - SKETCH_MAX_RETAINED_RECEIPTS);
    for (const evictedReceipt of evicted) {
      if (!working.expiredRequestIds.includes(evictedReceipt.requestId)) {
        working.expiredRequestIds.push(evictedReceipt.requestId);
      }
    }
    if (working.expiredRequestIds.length > SKETCH_MAX_EXPIRED_REQUEST_IDS) {
      working.expiredRequestIds.splice(
        0,
        working.expiredRequestIds.length - SKETCH_MAX_EXPIRED_REQUEST_IDS
      );
    }
  }

  return {
    ok: true,
    state: working,
    receipt,
    undoDepth: working.history.undo.length,
    redoDepth: working.history.redo.length
  };
}

function trimHistory(history: SketchState["history"]): void {
  while (history.undo.length > SKETCH_MAX_UNDO_ENTRIES) {
    history.undo.shift();
  }
  while (history.redo.length > SKETCH_MAX_UNDO_ENTRIES) {
    history.redo.shift();
  }
  while (historyBytes(history) > SKETCH_HISTORY_BYTE_BUDGET) {
    if (history.undo.length > 0) {
      history.undo.shift();
    } else if (history.redo.length > 0) {
      history.redo.shift();
    } else {
      break;
    }
  }
}

function historyBytes(history: SketchState["history"]): number {
  let total = 0;
  for (const entry of history.undo) {
    total += Buffer.byteLength(JSON.stringify(entry));
  }
  for (const entry of history.redo) {
    total += Buffer.byteLength(JSON.stringify(entry));
  }
  return total;
}

// --- idempotency -----------------------------------------------------------------

function replayReceipt(
  state: SketchState,
  requestId: string,
  fingerprint: string
): SketchTransactionResult | undefined {
  // Receipts are consulted before the revision check on purpose: a retry of
  // a request that already succeeded must hear about that success even if
  // later transactions have since moved the revision on.
  for (const receipt of state.receipts) {
    if (receipt.requestId !== requestId) {
      continue;
    }
    if (receipt.requestFingerprint === fingerprint) {
      return {
        ok: true,
        state,
        receipt,
        undoDepth: state.history.undo.length,
        redoDepth: state.history.redo.length
      };
    }
    return {
      ok: false,
      error: {
        code: "request_id_conflict",
        message: `Request id "${requestId}" was already used with different input`
      }
    };
  }
  // An evicted request id is neither replayable (its fingerprint left with the
  // receipt) nor safe to re-run (it may already have committed), so the retry
  // is told the outcome cannot be determined rather than being answered
  // through the stale-revision path, which would invite a blind re-send.
  if (state.expiredRequestIds.includes(requestId)) {
    return {
      ok: false,
      error: {
        code: "outcome_unknown",
        currentRevision: state.document.revision,
        message: `Request id "${requestId}" is no longer retained; its outcome cannot be determined. Read the current document and retry explicitly with a new request id`
      }
    };
  }
  return undefined;
}

function commitFingerprint(commit: {
  baseRevision: number;
  actor: SketchActor;
  turnId?: string;
  label?: string;
  operations: unknown;
}): string {
  return sha256Hex(
    JSON.stringify({
      kind: "commit",
      baseRevision: commit.baseRevision,
      actor: commit.actor,
      turnId: commit.turnId ?? null,
      label: commit.label ?? null,
      operations: commit.operations
    })
  );
}

function undoRedoFingerprint(
  kind: "undo" | "redo",
  request: { baseRevision: number; actor: SketchActor; turnId?: string; label?: string }
): string {
  return sha256Hex(
    JSON.stringify({
      kind,
      baseRevision: request.baseRevision,
      actor: request.actor,
      turnId: request.turnId ?? null,
      label: request.label ?? null
    })
  );
}

function checkStaleRevision(
  state: SketchState,
  baseRevision: number
): SketchCoreError | undefined {
  if (baseRevision !== state.document.revision) {
    return {
      code: "stale_revision",
      currentRevision: state.document.revision,
      message: `Base revision ${baseRevision} does not match current revision ${state.document.revision}; refresh and retry explicitly`
    };
  }
  return undefined;
}

function invalidRequestError(error: ZodError): SketchCoreError {
  const issues = error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return {
    code: "invalid_request",
    message: `Sketch request failed validation: ${issues.join("; ")}`
  };
}
