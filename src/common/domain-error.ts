export type DomainErrorCode =
  | 'USER_BLOCKED'
  | 'AGE_NOT_CONFIRMED'
  | 'INVALID_PHONE'
  | 'NUMBER_BLOCKED'
  | 'DAILY_LIMIT'
  | 'WEEKLY_LIMIT'
  | 'INSUFFICIENT_FUNDS'
  | 'MODERATION_REJECTED'
  | 'INVALID_NAME'
  | 'UNKNOWN_SCENARIO'
  | 'OUTSIDE_CALL_WINDOW'
  | 'TEMPORARY_FAILURE';

/** Expected business error; `message` is safe to show to the Telegram user (uk). */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
