import { describe, expect, it } from 'vitest';

import { REDACTED } from './diagnostics.js';
import { createLogger, DEFAULT_LOG_LEVEL, LOG_LEVELS, resolveLogLevel, writeToStandardError } from './logger.js';
import type { Logger, LogLevel } from './logger.js';

const SECRET = 'm_mcp_abcdefghijklmnop';

interface Harness {
  readonly logger: Logger;
  readonly lines: string[];
}

/** A logger writing into an array, on a clock that does not move. */
function buildLogger(level: LogLevel, secrets: readonly string[] = []): Harness {
  const lines: string[] = [];
  const logger = createLogger({
    name: 'test-connector',
    level,
    secrets,
    write: (line: string): void => {
      lines.push(line);
    },
    now: (): Date => new Date('2026-01-01T00:00:00.000Z'),
  });

  return { logger, lines };
}

describe('createLogger', () => {
  it('writes one JSON object per line, newline terminated', () => {
    const { logger, lines } = buildLogger('info');

    logger.info({ endpoint: 'https://host.example/mcp' }, 'connector ready on stdio');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      level: 'info',
      time: '2026-01-01T00:00:00.000Z',
      name: 'test-connector',
      msg: 'connector ready on stdio',
      endpoint: 'https://host.example/mcp',
    });
  });

  it('suppresses anything below the configured level', () => {
    const { logger, lines } = buildLogger('warn');

    logger.debug({}, 'debug');
    logger.info({}, 'info');
    logger.warn({}, 'warn');
    logger.error({}, 'error');

    expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(['warn', 'error']);
  });

  it('writes nothing at all when silenced', () => {
    const { logger, lines } = buildLogger('silent');

    for (const level of LOG_LEVELS) {
      if (level !== 'silent') {
        logger[level]({}, level);
      }
    }

    expect(lines).toEqual([]);
  });

  it('scrubs a registered secret from the finished line', () => {
    const { logger, lines } = buildLogger('debug', [SECRET]);

    // Deliberately the worst case: a call site that put the token in a field it
    // should not have. The scrub is what stands between that mistake and a
    // credential in a merchant's client log pane.
    logger.error({ url: `https://host.example/mcp?p=${SECRET}` }, `presenting ${SECRET}`);

    const line = lines[0] ?? '';
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain(SECRET.slice(0, 16));
    expect(line).toContain(REDACTED);
  });

  it('renders an Error detail as its message, which JSON.stringify would drop', () => {
    const { logger, lines } = buildLogger('error');

    logger.error({ error: new Error('the endpoint refused') }, 'failed');

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ error: 'the endpoint refused' });
  });

  it('keeps the fixed fields when a detail cannot be serialised', () => {
    const { logger, lines } = buildLogger('error');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    logger.error({ circular }, 'still worth a line');

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      level: 'error',
      time: '2026-01-01T00:00:00.000Z',
      name: 'test-connector',
      msg: 'still worth a line',
      details: 'omitted: not serialisable',
    });
  });

  it('does not let a detail displace the fields a reader needs', () => {
    const { logger, lines } = buildLogger('info');

    logger.info({ msg: 'hijacked', level: 'debug' }, 'the real message');

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ level: 'info', msg: 'the real message' });
  });
});

describe('writeToStandardError', () => {
  it('never writes to stdout, whatever else it does', () => {
    // stdout is the JSON-RPC channel. This asserts the default sink against the
    // one thing that would corrupt a session; the line itself goes to the real
    // file descriptor 2, which is exactly where it belongs.
    const written: unknown[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      written.push(chunk);
      return true;
    };

    try {
      writeToStandardError('{"level":"info","msg":"default sink under test"}\n');
    } finally {
      process.stdout.write = original;
    }

    expect(written).toEqual([]);
  });

  it('does not throw when the descriptor refuses the line', () => {
    expect(() => {
      writeToStandardError('');
    }).not.toThrow();
  });
});

describe('resolveLogLevel', () => {
  it('defaults when nothing is configured', () => {
    expect(resolveLogLevel(undefined)).toEqual({ level: DEFAULT_LOG_LEVEL, recognised: true });
    expect(resolveLogLevel('   ')).toEqual({ level: DEFAULT_LOG_LEVEL, recognised: true });
  });

  it('accepts every level it advertises, in any casing and with stray whitespace', () => {
    for (const level of LOG_LEVELS) {
      expect(resolveLogLevel(` ${level.toUpperCase()} `)).toEqual({ level, recognised: true });
    }
  });

  it('reports an unrecognised value rather than failing start-up over it', () => {
    // A typo in a diagnostic setting must not take a merchant's whole tool
    // surface down; `run.ts` warns about the fallback instead.
    expect(resolveLogLevel('verbose')).toEqual({ level: DEFAULT_LOG_LEVEL, recognised: false });
  });
});
