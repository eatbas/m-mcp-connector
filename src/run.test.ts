import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { ConnectorConfigError, resolveConfig, TOKEN_ENV_VAR, URL_ENV_VAR } from './config.js';
import { TOKEN_QUERY_PARAMETER } from './diagnostics.js';
import { LOG_LEVEL_ENV_VAR } from './logger.js';
import { MINIMUM_NODE_MAJOR } from './node-version.js';
import { RemoteConnectionError } from './remote.js';
import { createConnectorLogger, faultOf, main, registerShutdownHandlers, startConnector } from './run.js';
import type { RetryPolicy } from './remote.js';
import type { RunningConnector, SignalTarget } from './run.js';
import {
  createCapturingSink,
  createHostedEndpoint,
  TEST_ENDPOINT_URL,
  TEST_TOKEN,
  waitFor,
} from './testing/endpoint.js';
import type { CapturedOutput, HostedEndpointStub } from './testing/endpoint.js';

const FAST_RETRY: RetryPolicy = { attempts: 2, initialDelayMs: 1, growthFactor: 2, maximumDelayMs: 4 };

const ENV = { [TOKEN_ENV_VAR]: TEST_TOKEN, [URL_ENV_VAR]: TEST_ENDPOINT_URL, [LOG_LEVEL_ENV_VAR]: 'debug' } as const;

interface Session {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly output: CapturedOutput;
  readonly stub: HostedEndpointStub;
  readonly exitCode: Promise<number>;
  readonly signals: EventEmitter & SignalTarget;
}

const sessions: Session[] = [];

/** Start `main` against an in-process endpoint, on pipes the test owns. */
function startSession(env: NodeJS.ProcessEnv = { ...ENV }, stub = createHostedEndpoint()): Session {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  // Drained so the transport's writes never block on a full pipe.
  stdout.resume();
  const output = createCapturingSink();
  const signals = new EventEmitter() as EventEmitter & SignalTarget;

  const exitCode = main({
    argv: [],
    env,
    stdin,
    stdout,
    write: output.write,
    fetch: stub.fetch,
    retry: FAST_RETRY,
    signalTarget: signals,
  });

  const session: Session = { stdin, stdout, output, stub, exitCode, signals };
  sessions.push(session);
  return session;
}

afterEach(async () => {
  while (sessions.length > 0) {
    const session = sessions.pop();
    session?.stdin.end();
    await session?.exitCode;
  }
});

describe('main, when it cannot start', () => {
  it('reports a missing token as a configuration fault, and leaves with a non-zero code', async () => {
    const output = createCapturingSink();

    const exitCode = await main({ argv: [], env: {}, write: output.write });

    expect(exitCode).toBe(1);
    expect(output.records()[0]).toMatchObject({ level: 'error', fault: 'configuration' });
    expect(output.text()).toContain(TOKEN_ENV_VAR);
  });

  it('reports a refused token as a configuration fault, because no amount of waiting fixes it', async () => {
    const output = createCapturingSink();
    const stub = createHostedEndpoint({ behaviour: { refuseWith: 401 } });

    const exitCode = await main({
      argv: [],
      env: { ...ENV },
      write: output.write,
      fetch: stub.fetch,
      retry: FAST_RETRY,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    });

    expect(exitCode).toBe(1);
    expect(output.text()).toContain('did not accept this access token');
    expect(output.records().at(-1)).toMatchObject({ fault: 'credential' });
  });

  it('reports an unreachable endpoint after exhausting the retry budget', async () => {
    const output = createCapturingSink();
    const stub = createHostedEndpoint({ behaviour: { unreachable: true } });

    const exitCode = await main({
      argv: [],
      env: { ...ENV },
      write: output.write,
      fetch: stub.fetch,
      retry: FAST_RETRY,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    });

    expect(exitCode).toBe(1);
    expect(output.text()).toContain('ECONNREFUSED');
    // Not `configuration`: nothing the merchant set is wrong, so telling them to
    // check their settings would send them looking in the wrong place.
    expect(output.records().at(-1)).toMatchObject({ fault: 'endpoint' });
  });

  it('never writes the token, even when start-up fails', async () => {
    const output = createCapturingSink();
    const stub = createHostedEndpoint({ behaviour: { refuseWith: 401 } });

    await main({
      argv: [`${TEST_ENDPOINT_URL}?${TOKEN_QUERY_PARAMETER}=${TEST_TOKEN}`],
      env: { [LOG_LEVEL_ENV_VAR]: 'debug' },
      write: output.write,
      fetch: stub.fetch,
      retry: FAST_RETRY,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    });

    expect(output.text()).not.toContain(TEST_TOKEN);
    expect(output.text()).not.toContain(TEST_TOKEN.slice(0, 16));
  });
});

describe('main, on an unsupported Node', () => {
  const UNSUPPORTED = `${String(MINIMUM_NODE_MAJOR - 2)}.19.0`;

  it('refuses with one sentence rather than a runtime error from a dependency', async () => {
    // `engines.node` only warns unless the installer set `engine-strict`, so
    // without this check a merchant on an old Node sees whatever the oldest
    // unsupported feature happens to raise — which names a line in a dependency
    // and not the cause.
    const output = createCapturingSink();

    const exitCode = await main({ argv: [], env: { ...ENV }, write: output.write, nodeVersion: UNSUPPORTED });

    expect(exitCode).toBe(1);
    expect(output.records()[0]).toMatchObject({ level: 'error', fault: 'configuration' });
    expect(output.text()).toContain(UNSUPPORTED);
    expect(output.text()).toContain(String(MINIMUM_NODE_MAJOR));
  });

  it('never reaches the endpoint', async () => {
    const stub = createHostedEndpoint();
    const output = createCapturingSink();

    await main({ argv: [], env: { ...ENV }, write: output.write, fetch: stub.fetch, nodeVersion: UNSUPPORTED });

    expect(stub.targets).toEqual([]);
  });

  it('runs on a version it cannot parse, rather than refusing over its own defect', async () => {
    const output = createCapturingSink();

    const exitCode = await main({ argv: [], env: {}, write: output.write, nodeVersion: 'unknown' });

    // Reaches the configuration check and fails on the missing token instead.
    expect(exitCode).toBe(1);
    expect(output.text()).toContain(TOKEN_ENV_VAR);
    expect(output.text()).not.toContain('too old');
  });
});

describe('main, when asked for a doctor report', () => {
  it('writes the report to the report stream and never to the protocol channel', async () => {
    // The whole safety argument for `doctor` writing to stdout is that it runs
    // instead of a session. This asserts the two streams stay separate.
    const stub = createHostedEndpoint();
    const output = createCapturingSink();
    const reports: string[] = [];

    const exitCode = await main({
      argv: ['doctor'],
      env: { ...ENV },
      write: output.write,
      writeReport: (text) => reports.push(text),
      fetch: stub.fetch,
      binaryPath: '/usr/local/bin/m-mcp-connector',
    });

    expect(exitCode).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('/usr/local/bin/m-mcp-connector');
    expect(reports[0]).not.toContain(TEST_TOKEN);
    expect(output.text()).toBe('');
  });

  it('reports an unsupported Node instead of refusing to run at all', async () => {
    // Ordering: the subcommand is taken before the Node floor is enforced, so
    // the merchant whose connector will not start still gets a report.
    const reports: string[] = [];

    const exitCode = await main({
      argv: ['doctor'],
      env: { ...ENV },
      writeReport: (text) => reports.push(text),
      nodeVersion: `${String(MINIMUM_NODE_MAJOR - 2)}.19.0`,
      binaryPath: '/usr/local/bin/m-mcp-connector',
    });

    expect(exitCode).toBe(1);
    expect(reports[0]).toContain('too old');
  });
});

describe('main, once it is serving', () => {
  it('announces itself and reports where the token came from', async () => {
    const session = startSession();

    await waitFor(() => session.output.text().includes('connector ready on stdio'));

    expect(session.output.records().at(-1)).toMatchObject({
      msg: 'connector ready on stdio',
      tokenSource: 'environment',
      endpoint: 'https://hosted.example.test/mcp',
    });
  });

  it('leaves cleanly when the client closes stdin', async () => {
    const session = startSession();
    await waitFor(() => session.output.text().includes('connector ready on stdio'));

    session.stdin.end();

    await expect(session.exitCode).resolves.toBe(0);
    sessions.pop();
  });

  it('leaves cleanly on SIGTERM', async () => {
    const session = startSession();
    await waitFor(() => session.output.text().includes('connector ready on stdio'));

    session.signals.emit('SIGTERM', 'SIGTERM');

    await expect(session.exitCode).resolves.toBe(0);
    sessions.pop();
  });

  it('leaves with a failure code on a rejection nothing handled', async () => {
    // A rejection nobody caught leaves the connector in a state it cannot
    // describe; carrying on would serve requests from it.
    const session = startSession();
    await waitFor(() => session.output.text().includes('connector ready on stdio'));

    session.signals.emit('unhandledRejection', new Error('a promise nobody awaited'));

    await expect(session.exitCode).resolves.toBe(1);
    expect(session.output.text()).toContain('unhandled promise rejection');
    sessions.pop();
  });

  it('leaves with a failure code on an exception nothing caught', async () => {
    const session = startSession();
    await waitFor(() => session.output.text().includes('connector ready on stdio'));

    session.signals.emit('uncaughtException', new Error('something threw'));

    await expect(session.exitCode).resolves.toBe(1);
    sessions.pop();
  });

  it('writes the configuration warnings it collected', async () => {
    const session = startSession({ ...ENV, [LOG_LEVEL_ENV_VAR]: 'verbose' });

    await waitFor(() => session.output.text().includes('connector ready on stdio'));

    expect(session.output.text()).toContain(LOG_LEVEL_ENV_VAR);
  });
});

describe('startConnector', () => {
  it('lets the first caller of stop decide the reason and the code', async () => {
    const stub = createHostedEndpoint();
    const output = createCapturingSink();
    const config = resolveConfig([], { ...ENV });
    const connector = await startConnector({
      config,
      logger: createConnectorLogger(config, output.write),
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      fetch: stub.fetch,
      retry: FAST_RETRY,
    });

    connector.stop('first', 3);
    connector.stop('second', 0);

    await expect(connector.stopped).resolves.toBe(3);
    expect(output.text()).toContain('first');
    expect(output.text()).not.toContain('second');
  });
});

describe('faultOf', () => {
  it('separates the four situations a start-up failure can be', () => {
    expect(faultOf(new ConnectorConfigError('bad'))).toBe('configuration');
    expect(faultOf(new RemoteConnectionError({ kind: 'unauthorised', message: 'no' }))).toBe('credential');
    expect(faultOf(new RemoteConnectionError({ kind: 'forbidden', message: 'no' }))).toBe('credential');
    expect(faultOf(new RemoteConnectionError({ kind: 'unreachable', message: 'down' }))).toBe('endpoint');
    expect(faultOf(new RemoteConnectionError({ kind: 'rateLimited', message: 'busy' }))).toBe('endpoint');
    expect(faultOf(new TypeError('a defect'))).toBe('connector');
  });
});

describe('registerShutdownHandlers', () => {
  it('routes both signals and both fault events into one stop', () => {
    const stopped: { reason: string; exitCode: number }[] = [];
    const connector: Pick<RunningConnector, 'stop'> = {
      stop: (reason, exitCode): void => {
        stopped.push({ reason, exitCode });
      },
    };
    const output = createCapturingSink();
    const target = new EventEmitter() as EventEmitter & SignalTarget;
    const config = resolveConfig([], { ...ENV });

    registerShutdownHandlers({ connector, logger: createConnectorLogger(config, output.write), target });

    target.emit('SIGINT', 'SIGINT');
    target.emit('SIGTERM', 'SIGTERM');
    target.emit('unhandledRejection', new Error('rejected'));
    target.emit('uncaughtException', new Error('threw'));

    expect(stopped).toEqual([
      { reason: 'SIGINT', exitCode: 0 },
      { reason: 'SIGTERM', exitCode: 0 },
      { reason: 'unhandledRejection', exitCode: 1 },
      { reason: 'uncaughtException', exitCode: 1 },
    ]);
  });
});
