/**
 * Redini v3 — transaction layer for agentic web actions.
 *
 * Centre of gravity: the multi-operation ChangeSet.
 * One agent intent → one WebMCP call → one ChangeSet of individually
 * addressable operations. The human can preview the result, amend parameters,
 * skip operations (cherry-pick) and atomically commit the subset.
 * The receipt records the distance between the agent's INTENTION and the
 * human co-authored RESULT. Undo is deterministic: limited inverse operations,
 * not generic snapshots.
 */

export type ChangeSetStatus =
  | 'proposed'
  | 'reviewing'
  | 'committed'
  | 'declined'
  | 'undone'
  | 'stale'
  | 'failed';

export type OperationStatus = 'intended' | 'amended' | 'skipped' | 'applied' | 'failed';

/** A single, individually addressable change with a limited inverse. */
export interface Operation {
  id: string;
  kind: string;
  label: string;
  params: Record<string, unknown>;
}

/** Public view of one operation inside a ChangeSet. */
export interface ChangeSetOperation {
  id: string;
  kind: string;
  label: string;
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
  operations: ChangeSetOperation[];
  stateVersion: number;
  status: ChangeSetStatus;
  proposedAt: number;
  committedAt: number | null;
}

export interface ReceiptRow {
  id: string;
  label: string;
  params: Record<string, unknown>;
}

/**
 * The memorable artifact: the distance between what the agent intended
 * and what the human actually co-authored.
 */
export interface ChangeSetReceipt {
  transactionId: string;
  tool: string;
  intent: string;
  intended: ReceiptRow[];
  /** Ops whose parameters were changed by the human (and applied). */
  amended: ReceiptRow[];
  /** Ops excluded by the human. */
  skippedByHuman: ReceiptRow[];
  /** Op ids applied, in order. */
  applied: string[];
  stateVersionBefore: number;
  stateVersionAfter: number;
  undoToken: string;
  committedAt: number;
}

export interface UndoEvent {
  type: 'undo';
  transactionId: string;
  tool: string;
  undoToken: string;
  undoneAt: number;
}

export type AuditKind =
  | 'proposed'
  | 'reviewing'
  | 'committed'
  | 'declined'
  | 'failed'
  | 'stale'
  | 'rolled_back'
  | 'cancelled';

export interface AuditEntry {
  kind: AuditKind;
  txId: string;
  tool: string;
  at: number;
  detail?: Record<string, unknown>;
}

export interface PreviewInfo {
  summary: string;
  /** Domain-specific payload — for Atelier: the simulated design after the subset. */
  diff?: unknown;
}

/** Structured outcome returned to the agent. The conversation never dies on Redini. */
export type AgentOutcome =
  | {
      status: 'committed';
      txId: string;
      intent: string;
      appliedCount: number;
      amendedCount: number;
      skippedCount: number;
      receipt: ChangeSetReceipt;
    }
  | { status: 'declined_by_user'; txId: string; reason?: string }
  | { status: 'cancelled'; txId: string }
  | { status: 'stale_transaction'; txId: string; message: string }
  | { status: 'execute_failed'; txId: string; error: string };

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
  /** Optional per-operation validation. Return an error string to reject. */
  validate?: (op: { kind: string; params: Record<string, unknown> }) => string | null;
  runtime: OperationRuntime;
  /** Human one-liner for an operation, e.g. `title → "AI SUMMIT"`. */
  describeOperation?: (op: { kind: string; params: Record<string, unknown> }) => string;
  /** App-owned state version for the explicit stale guard. Optional but recommended. */
  getStateVersion?: () => number;
}

export type RegisterToolRequest =
  | (SafeToolDefinition & { mode: 'safe' })
  | (ChangeSetToolDefinition & { mode: 'changeset' });

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
  onAudit(entry: AuditEntry): void;
}
