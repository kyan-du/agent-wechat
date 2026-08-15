export const EXIT = {
  OK: 0,
  ARGUMENT: 2,
  ENVIRONMENT: 3,
  SERVICE: 4,
  AUTH: 5,
  TARGET: 6,
  CONFIRMATION: 7,
  RATE_LIMITED: 8,
  UNCERTAIN: 9,
  CLEANUP: 10,
  ROLLBACK: 11,
} as const;

export type OutputEnvelope<T = unknown> =
  | { schemaVersion: 1; ok: true; code: "OK"; data: T }
  | { schemaVersion: 1; ok: false; code: string; error: string; retryAfter?: number; commitAttempted?: boolean; diagnostics?: unknown };

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number,
    readonly details?: { retryAfter?: number; commitAttempted?: boolean; diagnostics?: unknown },
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function printJson<T>(value: OutputEnvelope<T>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function success<T>(data: T): OutputEnvelope<T> {
  return { schemaVersion: 1, ok: true, code: "OK", data };
}

export function failure(error: CliError): OutputEnvelope<never> {
  return {
    schemaVersion: 1,
    ok: false,
    code: error.code,
    error: error.message,
    ...error.details,
  };
}
