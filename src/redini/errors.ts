export type RediniErrorCode =
  | 'UNKNOWN_TOOL'
  | 'UNKNOWN_CHANGESET'
  | 'UNKNOWN_TOKEN'
  | 'ALREADY_DECIDED'
  | 'ALREADY_UNDONE'
  | 'STALE_TRANSACTION'
  | 'INVALID_OPERATION'
  | 'EMPTY_CHANGESET';

export class RediniError extends Error {
  readonly code: RediniErrorCode;

  constructor(code: RediniErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'RediniError';
    this.code = code;
  }
}
