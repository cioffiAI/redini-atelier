/**
 * Redini v3 — transaction layer for agentic web actions.
 *
 * Centre of gravity: the multi-operation ChangeSet.
 * One agent intent → one WebMCP call → one ChangeSet of individually
 * addressable operations. The human can preview the result, amend parameters,
 * skip operations (cherry-pick) and atomically commit the subset.
 * The receipt records the distance between the agent's INTENTION and the
 * human co-authored RESULT. Undo/redo is deterministic, editor-style history:
 * limited inverse operations, not generic snapshots.
 */

export type ChangeSetStatus =
  | 'proposed'
  | 'reviewing'
  | 'committed'
  | 'declined'
  | 'cancelled'
  | 'undone'
  | 'stale'
  | 'failed'
  | 'undo_failed';

export type OperationStatus = 'intended' | 'amended' | 'skipped' | 'applied' | 'failed';

/**
 * Generic ChangeSet size caps (DoS). The guard enforces them at dispatch — it
 * never trusts the host's schema enforcement — and the app's inputSchema
 * mirrors them verbatim. Apps can be stricter via their own per-op validator;
 * these are Redini's own hard bounds. Value-length caps (e.g. 120 chars) stay
 * app-side: they are domain-specific, not generic ChangeSet limits.
 */
export const CHANGESET_LIMITS = {
  /** Maximum number of operations per ChangeSet. */
  maxOps: 32,
  /** Maximum length of the intent string, in characters. */
  maxIntentLength: 200,
} as const;

/**
 * Statuses that END the negotiation: no live buttons, no preview, no further
 * human edits. Single source of truth shared by the guard (decided gates +
 * preview suppression) and the UI (terminal card rendering).
 */
export const DECIDED_CHANGESET_STATUSES: readonly ChangeSetStatus[] = [
  'committed',
  'declined',
  'cancelled',
  'undone',
  'stale',
  'failed',
  'undo_failed',
];

/** A single, individually addressable change with a limited inverse. */
export interface Operation {
  id: string;
  kind: string;
  /** Human one-liner; recomputed from the CURRENT (possibly amended) params. */
  label: string;
  /**
   * The description the agent originally proposed — set once at dispatch, never
   * recomputed. OPTIONAL on purpose: only the guard fills it for STAGED ops;
   * runtime.apply() returns inverse Operations and is not required to carry
   * provenance (ChangeSetOperation.originalLabel stays required: the guard
   * always provides it).
   */
  originalLabel?: string;
  params: Record<string, unknown>;
}

/** Public view of one operation inside a ChangeSet. */
export interface ChangeSetOperation {
  id: string;
  kind: string;
  /** Human one-liner; recomputed from the CURRENT (possibly amended) params. */
  label: string;
  /** What the agent originally proposed. */
  originalLabel: string;
  /** Current params (amended by the human, if so). */
  params: Record<string, unknown>;
  /** What the agent originally proposed. */
  originalParams: Record<string, unknown>;
  /** false = skipped by the human (cherry-pick). */
  included: boolean;
  amended: boolean;
  status: OperationStatus;
}

export interface ChangeSet {
  id: string;
  tool: string;
  /** The agent's stated intent, one sentence. */
  intent: string;
  /** Who staged the proposal: the agent (default) or a direct human action. */
  actor: 'agent' | 'human';
  operations: ChangeSetOperation[];
  stateVersion: number;
  status: ChangeSetStatus;
  proposedAt: number;
  committedAt: number | null;
  /**
   * Live staleness flag: the state moved (committed/undo/redo) since this
   * ChangeSet was proposed. Commit of a stale ChangeSet is lazily rejected
   * with STALE_TRANSACTION; the flag itself is a preview, not a lock.
   */
  isStale: boolean;
  /**
   * Honest atomicity: an apply was attempted and did not complete — the
   * resulting state may be partially applied. Redini reports stateUncertain
   * instead of claiming nothing happened. Set on every failed commit
   * (EXECUTION_FAILED and ROLLBACK_FAILED alike); undefined on clean outcomes
   * (committed/declined/cancelled/stale) and pre-staging failures (no apply
   * was ever attempted).
   */
  stateUncertain?: boolean;
}

export interface ReceiptRow {
  id: string;
  kind: string;
  /** Description of the CURRENT value of this row (label = amended/committed label). */
  label: string;
  /** The description the agent originally proposed (amended rows render "before → after"). */
  originalLabel?: string;
  params: Record<string, unknown>;
  /** The agent's original parameters, when they differ (amended rows). */
  originalParams?: Record<string, unknown>;
}

/**
 * The memorable artifact: the distance between what the agent intended
 * and what the human actually co-authored.
 */
export interface ChangeSetReceipt {
  transactionId: string;
  /** Alias of transactionId for the structured agent result. */
  changeSetId: string;
  tool: string;
  intent: string;
  /** Ops as the agent proposed them: original label + original params. */
  intended: ReceiptRow[];
  /** Ops whose parameters were changed by the human (and applied). */
  amended: ReceiptRow[];
  /** Ops excluded by the human. */
  skippedByHuman: ReceiptRow[];
  /** Every applied op with the ACTUAL COMMITTED values (current params + current label). */
  applied: ReceiptRow[];
  stateVersionBefore: number;
  stateVersionAfter: number;
  proposedAt: number;
  committedAt: number;
}

/** One deterministic step in the editor-style history. */
export interface HistoryEntry {
  id: string;
  changeSetId: string;
  tool: string;
  /** The NEGOTIATED forward set (current amended params + labels): what redo replays. */
  forwardOperations: Operation[];
  /** Collected inverses in REVERSE application order: what undo replays 1:1. */
  inverseOperations: Operation[];
  /** The immutable receipt captured at commit — never rewritten or re-emitted. */
  receipt: ChangeSetReceipt;
  committedAt: number;
}

export interface UndoEvent {
  type: 'undo';
  transactionId: string;
  tool: string;
  undoneAt: number;
}

export interface RedoEvent {
  type: 'redo';
  transactionId: string;
  tool: string;
  redoneAt: number;
}

export type AuditKind =
  | 'proposed'
  | 'reviewing'
  | 'committed'
  | 'declined'
  | 'failed'
  | 'stale'
  | 'cancelled'
  | 'undone'
  | 'undo_failed'
  | 'redone'
  | 'redo_failed';

export interface AuditEntry {
  kind: AuditKind;
  txId: string;
  tool: string;
  at: number;
  detail?: Record<string, unknown>;
  /** Provenance of the staged ChangeSet: human actions render as "You …", agent as "Agent …". */
  actor?: 'agent' | 'human';
}

export interface PreviewInfo {
  summary: string;
  /** Domain-specific payload — for Atelier: the simulated design after the subset. */
  diff?: unknown;
  /**
   * Set ONLY when `runtime.simulate` threw: the host app's simulator is broken.
   * `diff` is absent in that case, but absent-with-`error` and absent-because-
   * the-tool-was-torn-down are deliberately distinguishable — a human must
   * never be shown an empty preview that silently means "we could not compute
   * one". Adapters should surface this and treat the preview as unavailable.
   */
  error?: string;
}

/**
 * Structured outcome returned to the agent. The conversation never dies on Redini:
 * the changeset execute callback NEVER rejects and always resolves with this
 * direct, serializable object (no MCP text envelope).
 */
export interface ChangeSetResult {
  status: 'committed' | 'declined_by_user' | 'cancelled' | 'stale_transaction' | 'execute_failed';
  /** null when the failure happened BEFORE any ChangeSet was staged (pre-staging validation). */
  changeSetId: string | null;
  appliedCount: number;
  amendedCount: number;
  skippedCount: number;
  undoAvailable: boolean;
  /**
   * Honest atomicity: true for every execute_failed outcome — an apply was
   * attempted and did not complete, so the resulting state may be partially
   * applied; Redini reports stateUncertain instead of claiming nothing
   * happened. Undefined/absent on clean outcomes (committed, declined,
   * cancelled, stale_transaction) and pre-staging validation failures (no
   * apply was ever attempted).
   */
  stateUncertain?: boolean;
  error?: { code: string; message: string };
}

export type AgentOutcome = ChangeSetResult;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface ToolExecutionContext {
  signal: AbortSignal;
}

/** Read-only (or side-effect-free-for-the-agent) tool: executes immediately. */
export interface SafeToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  annotations?: ToolAnnotations;
  execute: (input: Record<string, unknown>, ctx: ToolExecutionContext) => unknown | Promise<unknown>;
}

/**
 * The app implements this against its own state. `apply` mutates the real
 * state and returns the inverse operation — that is what makes undo
 * deterministic instead of snapshot-based.
 */
export interface OperationRuntime {
  apply: (op: Operation) => Operation;
  /** Apply a subset to a throw-away copy of the state: the preview. */
  simulate: (ops: Array<{ kind: string; params: Record<string, unknown> }>) => unknown;
}

/**
 * The ONE agent-facing tool: an intent plus an array of operations.
 * The human amends, cherry-picks and atomically commits the subset.
 */
export interface ChangeSetToolDefinition {
  name: string;
  title?: string;
  description: string;
  /** Allowed operation kinds (app-defined vocabulary with inverses). */
  kinds: string[];
  /** Optional schema override; by default Redini generates one from `kinds`. */
  inputSchema?: object;
  /**
   * Optional per-operation validation. Return an error string to reject.
   * `priorOps` (when provided by the guard) carries the operations that
   * precede this one — current params, in proposal order — so a validator can
   * evaluate against the SEQUENTIAL derived state (e.g. logo bounds). Validators
   * that ignore the second argument stay fully backward compatible.
   */
  validate?: (
    op: { kind: string; params: Record<string, unknown> },
    priorOps?: Array<{ kind: string; params: Record<string, unknown> }>,
  ) => string | null;
  runtime: OperationRuntime;
  /** Human one-liner for an operation, e.g. `title → "AI SUMMIT"`. */
  describeOperation?: (op: { kind: string; params: Record<string, unknown> }) => string;
  /** App-owned state version for the explicit stale guard. Optional but recommended. */
  getStateVersion?: () => number;
}

/** Minimal structural type of the WebMCP model context Redini registers into. */
export interface ModelContextLike {
  registerTool(
    tool: {
      name: string;
      title?: string;
      description: string;
      inputSchema?: object;
      annotations?: ToolAnnotations;
      execute: (input: Record<string, unknown>, options: { signal: AbortSignal }) => unknown | Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<void> | void;
}

/** UI adapter contract: Redini is UI-agnostic. */
export interface UIAdapter {
  /** Upsert of the ChangeSet card (proposal, amendment, cherry-pick, status changes). */
  onChangesetUpdated(cs: ChangeSet, preview: PreviewInfo | null): void;
  onReceipt(receipt: ChangeSetReceipt): void;
  onUndo(event: UndoEvent): void;
  onRedo(event: RedoEvent): void;
  onAudit(entry: AuditEntry): void;
}
