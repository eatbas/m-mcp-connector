import { Buffer } from 'node:buffer';
import { writeSync } from 'node:fs';

import { describeError, redactSecrets } from './diagnostics.js';

/**
 * The connector's structured log, which goes to stderr and nowhere else.
 *
 * ── Why not `console`, and why not stdout ────────────────────────────────────
 *
 * This process speaks JSON-RPC over stdio: file descriptor 1 carries the
 * protocol, and one stray byte written there desynchronises the MCP client for
 * the remainder of the session. The failure does not surface as an error anyone
 * can read — it surfaces as a client that quietly stops responding. ESLint bans
 * `console` and `process.stdout` under `packages/connector/src/**` so the rule
 * is enforced rather than remembered, and this module is what makes obeying it
 * easy.
 *
 * ── Why not pino ─────────────────────────────────────────────────────────────
 *
 * Every other deployable in this workspace logs through pino, and this one
 * deliberately does not. `@atbas/m-mcp-connector` is published to npm and
 * installed globally by merchants on their own machines, so its dependency tree
 * is part of its attack surface and part of its start-up latency; it depends on
 * the MCP SDK and nothing else. The interface below keeps pino's argument order —
 * `info(details, message)` — so that a reader moving between this package and
 * `apps/mcp` is not switching conventions.
 *
 * Levels are written as names and the timestamp as ISO 8601, which is where the
 * format deviates from pino's numeric levels and epoch milliseconds. The
 * audience is the deciding factor: these lines are read by a merchant in an MCP
 * client's log pane, not by a log aggregator.
 *
 * ── Why writes are synchronous ───────────────────────────────────────────────
 *
 * `process.stderr.write` is asynchronous for pipes on macOS, which is exactly
 * the arrangement Claude Desktop creates and exactly the platform most of its
 * users are on. A connector that logs why it is about to exit and then exits
 * would lose that line — the one line that matters most. `writeSync` on file
 * descriptor 2 is the same guarantee `apps/mcp` buys with pino's
 * `destination({ sync: true })`.
 */

/** Ordered from quietest to loudest; the index is the comparison. */
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The only variable that changes this connector's verbosity.
 *
 * Deliberately prefixed rather than the bare `LOG_LEVEL` that `apps/mcp` reads.
 * An MCP client spawns this process with the merchant's own workspace
 * environment, which frequently already carries a `LOG_LEVEL` meant for
 * something else entirely; adopting it would make the connector's verbosity a
 * side effect of an unrelated project's configuration.
 */
export const LOG_LEVEL_ENV_VAR = 'M_MCP_LOG_LEVEL';

/** Used when nothing is configured, and when what is configured is not a level. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** File descriptor 1. Written by `doctor.ts` alone; see {@link writeToStandardOutput}. */
const STDOUT_FILE_DESCRIPTOR = 1;

/** File descriptor 2. */
const STDERR_FILE_DESCRIPTOR = 2;

/**
 * How many times a single line will be re-offered to a descriptor.
 *
 * A pipe that is momentarily full raises `EAGAIN`, and a partial write is
 * legal, so the write is a loop rather than a call. The bound is what
 * guarantees the loop ends: a stream that has refused a line ten times is a
 * stream this process cannot write to, and losing a diagnostic is strictly
 * better than spinning or crashing over one.
 */
const MAXIMUM_WRITE_ATTEMPTS = 10;

/** Stands in for the details of a record that could not be serialised. */
const UNSERIALISABLE_DETAILS = 'omitted: not serialisable';

/**
 * What the rest of this package logs through.
 *
 * Modules take this interface rather than a concrete logger, so that a test can
 * pass a recorder and so that nothing below the entry point is coupled to how
 * the lines are written. It mirrors `Logger` in `apps/mcp/src/logger.ts`, with
 * `debug` added because a merchant debugging a connector has no other way in.
 */
export interface Logger {
  debug(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface LoggerOptions {
  /** Emitted as `name`, so a line is attributable when a client interleaves several servers' stderr. */
  readonly name: string;
  readonly level: LogLevel;
  /**
   * Values removed from every line after it is serialised.
   *
   * The last line of defence rather than the first: no call site in this package
   * passes the token to the logger. This catches the value that arrived inside
   * something else — an error message, a URL in a `cause` — which is the route
   * a review cannot check by reading call sites.
   */
  readonly secrets?: readonly string[] | undefined;
  /** Where a finished line goes. Defaults to a synchronous write to stderr. */
  readonly write?: ((line: string) => void) | undefined;
  /** Injectable so a test asserting the record's shape does not race the clock. */
  readonly now?: (() => Date) | undefined;
}

/**
 * Write one line to a file descriptor, synchronously.
 *
 * Never throws. A connector that crashed because it could not log would be
 * worse than one that lost a line, and the only place the failure could be
 * reported is the stream that just refused it.
 *
 * @param descriptor - The file descriptor to write to.
 * @param line - The complete record, newline included.
 */
function writeToDescriptor(descriptor: number, line: string): void {
  const payload = Buffer.from(line, 'utf8');
  let written = 0;

  for (let attempt = 0; attempt < MAXIMUM_WRITE_ATTEMPTS && written < payload.length; attempt += 1) {
    try {
      written += writeSync(descriptor, payload, written);
    } catch (error: unknown) {
      // `EAGAIN` means a full pipe, which the next attempt may find drained.
      // Anything else means this descriptor is not going to accept the line.
      const retryable = error instanceof Error && 'code' in error && error.code === 'EAGAIN';
      if (!retryable) {
        return;
      }
    }
  }
}

/**
 * Write one line to stderr, synchronously.
 *
 * @param line - The complete record, newline included.
 */
export function writeToStandardError(line: string): void {
  writeToDescriptor(STDERR_FILE_DESCRIPTOR, line);
}

/**
 * Write one line to stdout, synchronously.
 *
 * **The one sanctioned write to file descriptor 1 in this package**, and it
 * exists for exactly one caller: `doctor.ts`, which runs instead of a session
 * rather than during one. Every rule above about stdout holds while the bridge
 * is serving — `m-mcp-connector doctor` never connects the stdio transport, so
 * there is no framing for its output to corrupt, and a diagnostic report is an
 * operator's expected stdout, pipeable and redirectable like any other command's.
 *
 * It lives here rather than in `doctor.ts` so that every write to a descriptor
 * in this package goes through the same retry loop, and so that a reader
 * looking for "what writes to stdout" finds the answer in the module whose
 * header explains why almost nothing may.
 *
 * @param line - The complete text, newline included.
 */
export function writeToStandardOutput(line: string): void {
  writeToDescriptor(STDOUT_FILE_DESCRIPTOR, line);
}

/**
 * Interpret the configured verbosity.
 *
 * An unrecognised value falls back to {@link DEFAULT_LOG_LEVEL} rather than
 * failing start-up: refusing to run because a merchant typed `verbose` would
 * take their whole tool surface down over a diagnostic setting. `run.ts` warns
 * about the fallback once the logger it needed exists.
 *
 * @param value - The raw environment value, or `undefined` when it is unset.
 * @returns The level to log at, and whether `value` was understood.
 */
export function resolveLogLevel(value: string | undefined): { readonly level: LogLevel; readonly recognised: boolean } {
  if (value === undefined || value.trim() === '') {
    return { level: DEFAULT_LOG_LEVEL, recognised: true };
  }

  const normalised = value.trim().toLowerCase();
  const match = LOG_LEVELS.find((level) => level === normalised);

  return match === undefined ? { level: DEFAULT_LOG_LEVEL, recognised: false } : { level: match, recognised: true };
}

/**
 * Render a detail value that `JSON.stringify` would drop or mangle.
 *
 * Errors are the case that matters: `JSON.stringify(new Error('x'))` is `{}`,
 * which is how a logged failure becomes a line with no failure in it.
 */
/**
 * One finished record. The four fixed fields are always present and always
 * serialisable, which is what lets {@link serialise} fall back to them.
 */
interface LogRecord {
  readonly level: LogLevel;
  readonly time: string;
  readonly name: string;
  readonly msg: string;
  readonly [detail: string]: unknown;
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return describeError(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

/** Serialise a record, degrading to something printable rather than throwing. */
function serialise(record: LogRecord): string {
  try {
    return JSON.stringify(record, replacer);
  } catch {
    // Reached by a circular structure among the details. The four fixed fields
    // are known to serialise, so the line survives without the part that failed
    // — a line naming the failure beats no line at all.
    const { level, time, name, msg } = record;
    return JSON.stringify({ level, time, name, msg, details: UNSERIALISABLE_DETAILS });
  }
}

/**
 * Build the connector's logger.
 *
 * @param options - Name, level, the secrets to scrub, and where lines go.
 * @returns A logger whose every line is a single JSON object on stderr.
 */
export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? writeToStandardError;
  const now = options.now ?? ((): Date => new Date());
  const secrets = options.secrets ?? [];
  const threshold = LOG_LEVELS.indexOf(options.level);

  function emit(level: Exclude<LogLevel, 'silent'>, details: Record<string, unknown>, message: string): void {
    if (LOG_LEVELS.indexOf(level) > threshold) {
      return;
    }

    // `msg` and the fixed fields are spread last so that a detail named `level`
    // or `msg` cannot displace them and make a line unreadable.
    const record: LogRecord = { ...details, level, time: now().toISOString(), name: options.name, msg: message };
    const line = serialise(record);
    write(`${redactSecrets(line, secrets)}\n`);
  }

  return {
    debug: (details, message): void => {
      emit('debug', details, message);
    },
    info: (details, message): void => {
      emit('info', details, message);
    },
    warn: (details, message): void => {
      emit('warn', details, message);
    },
    error: (details, message): void => {
      emit('error', details, message);
    },
  };
}
