export type FailureKind = 'content' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'unavailable';
// Somente mensagens públicas definidas pelos casos de uso; nunca copiar erro de driver.
export class ApplicationError extends Error {
  constructor(readonly code: string, message: string, readonly kind: FailureKind,
    readonly retryable = false, readonly retryAfterSeconds?: number,
    readonly conflict?: {current_version:number;expected_version:number}) { super(message); }
}
