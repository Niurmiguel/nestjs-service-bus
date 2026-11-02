/*
 * Internal helpers shared by the client and the server. Not exported from the
 * package root.
 */

/** The longest delay `setTimeout` honours; anything longer fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** How much of a value from a message is written to a log line. */
const LOGGED_VALUE_LIMIT = 200;

/**
 * A value that comes from a message (a `correlationId`, a `replyTo`, a
 * `messageId`...), ready to be written to a log line: JSON-quoted, so a line
 * break or a quote in it cannot fake another log line, and cut to a sane
 * length.
 */
export function quote(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : String(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  const cut =
    text.length > LOGGED_VALUE_LIMIT ? `${text.slice(0, LOGGED_VALUE_LIMIT)}...` : text;
  return value === undefined || value === null ? String(value) : JSON.stringify(cut);
}

/**
 * Reads a duration option meant for a timer: `undefined` (not set), `Infinity`
 * (no limit) or a number of milliseconds from 0 to `MAX_TIMER_MS`. Anything
 * else is a configuration mistake, reported when the client or server is
 * created rather than as a timer that fires at once.
 */
export function readTimerOption(name: string, value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value === "number" &&
    (value === Infinity || (Number.isFinite(value) && value >= 0 && value <= MAX_TIMER_MS))
  ) {
    return value;
  }
  throw new RangeError(
    `${name} must be a number of milliseconds from 0 to ${MAX_TIMER_MS}, or Infinity; got ${quote(
      value
    )}`
  );
}

/**
 * Reads a duration that is not a timer (e.g. a message TTL): `undefined` or
 * `Infinity` (not set), or at least 1 millisecond. Less than that is sent as
 * a time to live of 0, and every message would fail or expire at once.
 */
export function readDurationOption(name: string, value: unknown): number | undefined {
  if (value === undefined || value === Infinity) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return value;
  }
  throw new RangeError(
    `${name} must be a number of milliseconds of at least 1 (or Infinity); got ${quote(value)}`
  );
}

/** The connection string with its key or signature replaced. */
export function redactConnectionString(value: unknown): unknown {
  return typeof value === "string"
    ? value.replace(/(SharedAccess(?:Key|Signature)\s*=)[^;]*/gi, "$1<redacted>")
    : value;
}

/** Options as they may be shown: the connection string without its secret. */
export function redactOptions(options: unknown): unknown {
  if (typeof options !== "object" || options === null || !("connectionString" in options)) {
    return options;
  }
  return {
    ...options,
    connectionString: redactConnectionString(
      (options as { connectionString: unknown }).connectionString
    ),
  };
}

/** Logs at most one warning per `intervalMs` and counts the rest. */
export class RateLimitedWarning {
  private lastAt = -Infinity;
  private suppressed = 0;

  constructor(private readonly intervalMs: number) {}

  /**
   * Calls `warn` with `message` (plus how many were suppressed since the last
   * one) if the interval has passed; otherwise only counts it.
   */
  emit(warn: (message: string) => void, message: string): void {
    const now = Date.now();
    if (now - this.lastAt < this.intervalMs) {
      this.suppressed++;
      return;
    }
    const suppressed = this.suppressed;
    this.lastAt = now;
    this.suppressed = 0;
    warn(
      suppressed > 0
        ? `${message} (${suppressed} similar warning(s) suppressed since the last one)`
        : message
    );
  }
}
