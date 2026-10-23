export type MigrateErrorCode =
  | 'BAD_FILENAME'
  | 'DUPLICATE_VERSION'
  | 'EMPTY_MIGRATION'
  | 'BLOCKED'
  | 'LOCKED'
  | 'MIGRATION_FAILED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'CONFIG';

/**
 * Every error hk-migrate raises on purpose. `code` is stable and safe to
 * branch on; `message` is a sentence you can show a person, usually with the
 * command that fixes it.
 */
export class MigrateError extends Error {
  readonly code: MigrateErrorCode;

  constructor(code: MigrateErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrateError';
    this.code = code;
  }
}
