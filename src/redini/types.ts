/**
 * Redini — transaction layer for agentic web actions on WebMCP.
 *
 * Core semantics (v0.2):
 *   agent intent → proposed mutation → preview/diff → human edit → commit → receipt → undo
 *
 * Non-negotiable properties:
 *   1. Transactions are first-class objects with a lifecycle:
 *      proposed → reviewing → committed | declined → undone (terminal: stale | failed)
 *   2. Editable commit: the receipt preserves BOTH proposedInput and committedInput.
 *   3. Optimistic concurrency: a transaction proposed on a state that changed before
 *      commit fails explicitly (STALE_TRANSACTION) — never applies silently.
 *   4. Verifiable rollback: receipt.undoToken → undo() restores the exact previous
 *      state and produces a new undo event in the audit trail. Tokens are single-use.
 */

export type TransactionStatus =
  | 'proposed'
  | 'reviewing'
  | 'committed'
  | 'declined'
  | 'undone'
  | 'stale'
  | 'failed';

/** First-class transaction object. `committedInput` is set only after a commit. */
export interface Transaction {
  id: string;
  tool: string;
  proposedInput: Record<string, unknown>;
  committedInput: Record<string, unknown> | null;
  /** App-provided state version at proposal time (0 when the app has none). */
  stateVersion: number;
  status: TransactionStatus;
  proposedAt: number;
  committedAt: number | null;
}

/** Produced once per successful commit. Immutable. */
export interface Receipt {
  transactionId: string;
  tool: string;
  proposedInput: Record<string, unknown>;
  committedInput: Record<string, unknown>;
  stateBefore: unknown;
  stateAfter: unknown;
  /** Single-use token that lets undo() restore `stateBefore`. */
  undoToken: string;
  committedAt: number;
}

/** Produced once per successful undo. Enters the audit trail. */
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

/** Human-facing preview of what the proposed mutation would change. */
export interface PreviewInfo {
  summary: string;
  /** Domain-specific diff payload (rendered by the UI adapter). */
  diff?: unknown;
}

/** Structured outcome returned to the agent. The conversation never dies on Redini. */
export type AgentOutcome =
  | { status: 'committed'; txId: string; result: unknown; humanEdited: boolean }
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
  /** Human-readable label (WebMCP ModelContextTool.title). */
  title?: string;
  description: string;
  inputSchema?: object;
  annotations?: ToolAnnotations;
  execute: (input: Record<string, unknown>, ctx: ToolExecutionContext) => unknown | Promise<unknown>;
}

/** Mutating tool: every call becomes a staged transaction decided by the human. */
export interface TransactionalToolDefinition {
  name: string;
  /** Human-readable label (WebMCP ModelContextTool.title). */
  title?: string;
  description: string;
  inputSchema?: object;
  annotations?: ToolAnnotations;
  execute: (input: Record<string, unknown>, ctx: ToolExecutionContext) => unknown | Promise<unknown>;
  /** Capture the state to restore on undo. Must return an immutable snapshot. */
  snapshot: () => unknown;
  /** Restore a snapshot captured by `snapshot`. */
  restore: (stateBefore: unknown) => void | Promise<void>;
  /** Human-facing preview of the proposed change. */
  preview?: (input: Record<string, unknown>) => PreviewInfo | null;
  /**
   * App-owned state version for optimistic concurrency. Optional: Redini also
   * tracks its own mutation counter, so the stale guard works even without it.
   */
  getStateVersion?: () => number;
}

export type RegisterToolRequest =
  | (SafeToolDefinition & { mode: 'safe' })
  | (TransactionalToolDefinition & { mode: 'transaction' });

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

/** UI adapter contract: Redini is UI-agnostic; DOM, in-memory, or custom renderers plug in. */
export interface UIAdapter {
  /** Upsert of a transaction card (called on proposal, on edit, on every status change). */
  onTransactionUpdated(tx: Transaction, preview: PreviewInfo | null): void;
  onReceipt(receipt: Receipt): void;
  onUndo(event: UndoEvent): void;
  onAudit(entry: AuditEntry): void;
}
