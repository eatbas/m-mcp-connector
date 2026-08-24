import { PassThrough } from 'node:stream';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { TOKEN_ENV_VAR, URL_ENV_VAR } from './config.js';
import { LOG_LEVEL_ENV_VAR } from './logger.js';
import { main } from './run.js';
import type { RetryPolicy } from './remote.js';
import {
  createCapturingSink,
  createHostedEndpoint,
  STUB_RESOURCE_URI,
  STUB_TOOL,
  TEST_ENDPOINT_URL,
  TEST_TOKEN,
  waitFor,
} from './testing/endpoint.js';

/**
 * Protocol hygiene, over the transport this package actually ships with.
 *
 * On stdio, file descriptor 1 is the JSON-RPC channel: one stray byte written
 * there by application code desynchronises the client for the rest of the
 * session, and the failure surfaces as a client that mysteriously stops
 * responding rather than as an error anyone can read. ESLint bans `console` and
 * `process.stdout` under this package's `src/`; this asserts the same property
 * about everything the connector pulls in with it, across a whole request
 * cycle including the failure paths.
 *
 * The connector is given a pipe as its stdout rather than the process's own, so
 * that the frames can be read and parsed. That is what makes the assertion
 * possible AND what makes it strict: in production those are the same
 * descriptor, so "every byte on the transport is a JSON-RPC frame" and "nothing
 * at all reached `process.stdout`" together say that stdout carries the
 * protocol and nothing else.
 */

const FAST_RETRY: RetryPolicy = { attempts: 1, initialDelayMs: 1, growthFactor: 2, maximumDelayMs: 4 };

/** Divert a standard stream into `sink`, returning the restorer. */
function intercept(stream: NodeJS.WriteStream, sink: unknown[]): () => void {
  const original = stream.write.bind(stream);
  stream.write = (chunk: unknown): boolean => {
    sink.push(chunk);
    return true;
  };
  return (): void => {
    stream.write = original;
  };
}

interface JsonRpcFrame {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe('the stdio surface', () => {
  it('writes only JSON-RPC frames on stdout, and never the token anywhere', async () => {
    const processStdout: unknown[] = [];
    const processStderr: unknown[] = [];
    const frames: string[] = [];

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let pending = '';
    stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      frames.push(...lines);
    });

    // Deliberately the noisiest configuration there is, so that the token's
    // absence is asserted against the most output the connector can produce.
    const output = createCapturingSink();
    const stub = createHostedEndpoint({ withResources: true, withPrompts: true });

    const restoreStdout = intercept(process.stdout, processStdout);
    cleanups.push(restoreStdout);
    const restoreStderr = intercept(process.stderr, processStderr);
    cleanups.push(restoreStderr);

    let exitCode: number;
    try {
      const running = main({
        argv: [],
        env: {
          [TOKEN_ENV_VAR]: TEST_TOKEN,
          [URL_ENV_VAR]: TEST_ENDPOINT_URL,
          [LOG_LEVEL_ENV_VAR]: 'debug',
        },
        stdin,
        stdout,
        write: output.write,
        fetch: stub.fetch,
        retry: FAST_RETRY,
      });

      await waitFor(() => output.text().includes('connector ready on stdio'));

      const send = (message: unknown): void => {
        stdin.write(`${JSON.stringify(message)}\n`);
      };

      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'stdio-test', version: '0.0.0' },
        },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: STUB_TOOL, arguments: { query: 'ipn' } } });
      send({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
      send({ jsonrpc: '2.0', id: 5, method: 'resources/templates/list' });
      send({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: STUB_RESOURCE_URI } });
      send({ jsonrpc: '2.0', id: 7, method: 'ping' });
      await waitFor(() => frames.length >= 7);

      // Now the failure paths, which are where a diagnostic could carry a
      // secret and where a connector could be tempted to write a complaint
      // somewhere other than its logger.
      stub.behave({ refuseWith: 429, retryAfterSeconds: 30 });
      send({ jsonrpc: '2.0', id: 8, method: 'tools/list' });
      send({ jsonrpc: '2.0', id: 9, method: 'prompts/get', params: { name: 'nonexistent' } });
      await waitFor(() => frames.length >= 9);

      stdin.end();
      exitCode = await running;
    } finally {
      restoreStderr();
      restoreStdout();
      cleanups.length = 0;
    }

    // Asserted after the streams are handed back, so a failure is legible.
    expect(exitCode).toBe(0);

    const parsed = frames.map((frame): JsonRpcFrame => JSON.parse(frame) as JsonRpcFrame);
    expect(parsed).toHaveLength(9);
    for (const frame of parsed) {
      expect(frame.jsonrpc).toBe('2.0');
      expect(frame.result ?? frame.error).toBeDefined();
    }
    // Sorted, because the responses legitimately interleave: `ping` is answered
    // in process while a forwarded call is still in flight, and every one of
    // them is still a complete frame of its own.
    expect(parsed.map((frame) => frame.id).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // The cycle really did reach the endpoint, so the assertions below cannot
    // pass for the wrong reason.
    expect(JSON.stringify(parsed.find((frame) => frame.id === 3))).toContain('hosted:ipn');
    expect(JSON.stringify(parsed.find((frame) => frame.id === 6))).toContain(STUB_RESOURCE_URI);
    expect(JSON.stringify(parsed.find((frame) => frame.id === 8))).toContain('Retry after 30 seconds');
    expect(stub.authorisations).toContain(`Bearer ${TEST_TOKEN}`);

    // The point of the whole test.
    expect(processStdout).toEqual([]);

    const everythingWritten = [output.text(), processStderr.map(String).join(''), frames.join('\n')].join('\n');
    expect(everythingWritten).not.toContain(TEST_TOKEN);
    // Not even a prefix: a fragment of a secret still narrows a search.
    expect(everythingWritten).not.toContain(TEST_TOKEN.slice(0, 16));
    expect(everythingWritten).not.toContain('Bearer');
  });
});
