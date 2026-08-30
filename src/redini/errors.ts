export type RediniErrorCode =
  | 'UNKNOWN_TOOL'
  | 'UNKNOWN_CHANGESET'
  | 'ALREADY_DECIDED'
  | 'STALE_TRANSACTION'
  | 'INVALID_OPERATION'
  | 'INVALID_AMENDMENT'
  | 'EMPTY_CHANGESET'
  | 'EXECUTION_FAILED'
  | 'ROLLBACK_FAILED'
  | 'UNDO_FAILED'
  | 'REDO_FAILED'
  | 'NOTHING_TO_UNDO'
  | 'NOTHING_TO_REDO';

export class RediniError extends Error {
  readonly code: RediniErrorCode;
  override readonly cause?: unknown;
  /** Structured bundle for failure paths that carry partial-state detail (e.g. ROLLBACK_FAILED, UNDO_FAILED). */
  readonly detail?: Record<string, unknown>;

  constructor(code: RediniErrorCode, message: string, cause?: unknown, detail?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = 'RediniError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    if (detail !== undefined) this.detail = detail;
  }
}
