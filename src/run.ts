import process from 'node:process';
import type { Readable, Writable } from 'node:stream';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { ConnectorConfigError, resolveConfig } from './config.js';
import type { ConnectorConfig } from './config.js';
import { createBridge } from './bridge.js';
import { describeError } from './diagnostics.js';
import { runDoctor, takeDoctorSubcommand } from './doctor.js';
import { createLogger, DEFAULT_LOG_LEVEL, writeToStandardOutput } from './logger.js';
import type { Logger } from './logger.js';
import { isSupportedNode, unsupportedNodeMessage } from './node-version.js';
import { connectRemote, isPermanentFailure, RemoteConnectionError } from './remote.js';
import type { RetryPolicy } from './remote.js';
import { CONNECTOR_NAME, CONNECTOR_VERSION } from './version.js';

/**
 * Assembling the connector, and everything that is a *process* concern rather
 * than a protocol one: signals, faults, exit codes.
 *
 * Split from `cli.ts` so that all of it can be tested. `cli.ts` carries the
 * hashbang and one call, because a module with a hashbang cannot be imported by
 * a test without a syntax error, and a module that cannot be imported cannot be
 * proved.
 *
 * ── How this process ends ────────────────────────────────────────────────────
 *
 * By running out of work, not by `process.exit`. Once the stdio transport is
 * closed, nothing is holding the event loop open, so setting `process.exitCode`
 * and returning is enough — and it is strictly safer than exiting, because
 * `process.exit` truncates whatever has not yet reached a file descriptor. The
 * one thing that must survive a fatal error is the line saying what the fatal
 * error was.
 *
 * Every path that ends the connector goes through {@link RunningConnector.stop},
 * which is idempotent: a SIGTERM that arrives while the client is closing stdin
 * must not start a second teardown.
 */

/** How long a teardown may take before the process leaves anyway. */
const SHUTDOWN_GRACE_MS = 5_000;

export interface StartConnectorOptions {
  readonly config: ConnectorConfig;
  readonly logger: Logger;
  /** Defaults to `process.stdin`. A test passes a pipe it controls. */
  readonly stdin?: Readable | undefined;
  /** Defaults to `process.stdout`. A test passes a pipe it can read the protocol off. */
  readonly stdout?: Writable | undefined;
  /** Injected so a test answers the endpoint in process, and can assert the network was never touched. */
  readonly fetch?: FetchLike | undefined;
  /** Overridable so a test does not wait real seconds on a retry. */
  readonly retry?: RetryPolicy | undefined;
}

export interface RunningConnector {
  /** Origin and path of the endpoint being fronted. Safe to print. */
  readonly endpoint: string;
  /**
   * Resolves with the process exit code once the connector has stopped.
   *
   * Never rejects: a teardown that fails is logged and reported through the
   * code, because there is nothing above this to catch it usefully.
   */
  readonly stopped: Promise<number>;
  /**
   * Stop, and settle {@link stopped} with `exitCode`.
   *
   * Idempotent; the first caller decides the reason and the code.
   *
   * @param reason - One phrase for the log line. Never a secret.
   * @param exitCode - 0 when the client or an operator asked for this, non-zero when something failed.
   */
  stop(reason: string, exitCode: number): void;
}

/**
 * Build the logger the connector runs with.
 *
 * Exported so that the entry point and its tests construct the same one, with
 * the same redaction. The token is registered as a secret here and nowhere
 * else: every line the connector writes is scrubbed of it on the way out, which
 * is the guarantee that survives a call site nobody reviewed.
 *
 * @param config - The resolved configuration; supplies both the level and the secret.
 * @param write - Where finished lines go. Defaults to a synchronous write to stderr.
 * @returns The connector's logger.
 */
export function createConnectorLogger(config: ConnectorConfig, write?: (line: string) => void): Logger {
  return createLogger({
    name: CONNECTOR_NAME,
    level: config.logLevel,
    secrets: [config.token],
    ...(write === undefined ? {} : { write }),
  });
}

/**
 * Connect to the endpoint, put the bridge in front of it, and serve on stdio.
 *
 * @param options - The resolved configuration, the logger, and the injectable transports.
 * @returns The running connector.
 * @throws {RemoteConnectionError} If the endpoint refused the token or could not be reached.
 */
export async function startConnector(options: StartConnectorOptions): Promise<RunningConnector> {
  const { config, logger } = options;
  const stdin = options.stdin ?? process.stdin;

  const remote = await connectRemote({
    endpoint: config.endpoint,
    token: config.token,
    logger,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });

  const server = createBridge({ remote });
  // `options.stdout` is passed through even when it is `undefined`: the
  // transport's own default is the process's stdout, and letting it apply that
  // default is what keeps `process.stdout` from being named in this package at
  // all. ESLint bans the property here — see the rule's message — precisely so
  // that the only code writing to the protocol channel is the SDK's transport.
  const transport = new StdioServerTransport(stdin, options.stdout);

  let stopping = false;
  let settle: (exitCode: number) => void = () => undefined;
  const stopped = new Promise<number>((resolve) => {
    settle = resolve;
  });

  const stop = (reason: string, exitCode: number): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info({ reason, exitCode }, 'shutting down');

    // A teardown that wedges must not become a process that leaves with a
    // success code because nothing was left to keep it alive. The timer is
    // deliberately NOT unreferenced: it is the only thing that would still
    // settle the exit code if the close below never resolved, and it is cleared
    // on the ordinary path before it can delay anything.
    const forced = setTimeout(() => {
      logger.error({ graceMs: SHUTDOWN_GRACE_MS }, 'shutdown did not finish within the grace period');
      settle(exitCode === 0 ? 1 : exitCode);
    }, SHUTDOWN_GRACE_MS);

    // Outermost first: stop accepting client requests, then release the
    // connection those requests were being forwarded to.
    void server
      .close()
      .then(async () => remote.close())
      .catch((error: unknown) => {
        logger.error({ error: describeError(error) }, 'the connector did not shut down cleanly');
      })
      .finally(() => {
        clearTimeout(forced);
        settle(exitCode);
      });
  };

  // Two ways the client can end the session, and both are ordinary. `onclose`
  // covers the transport being closed; `end` on stdin covers the client simply
  // closing the pipe, which the SDK's stdio transport does not watch for.
  server.onclose = (): void => {
    stop('the client closed the connection', 0);
  };
  stdin.once('end', () => {
    stop('the client closed stdin', 0);
  });

  await server.connect(transport);

  logger.info(
    {
      endpoint: remote.label,
      tokenSource: config.tokenSource,
      connectorVersion: CONNECTOR_VERSION,
      server: remote.serverInfo?.name ?? 'unnamed',
      serverVersion: remote.serverInfo?.version ?? 'unknown',
    },
    'connector ready on stdio',
  );

  return { endpoint: remote.label, stopped, stop };
}

/** The part of `process` {@link registerShutdownHandlers} touches. */
export interface SignalTarget {
  on(event: 'SIGINT' | 'SIGTERM', listener: (signal: NodeJS.Signals) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown;
}

export interface ShutdownHandlerOptions {
  readonly connector: Pick<RunningConnector, 'stop'>;
  readonly logger: Logger;
  /** Defaults to `process`. A test passes an emitter nothing else is listening on. */
  readonly target?: SignalTarget | undefined;
}

/**
 * Route the ways this process can be told to stop into one shutdown.
 *
 * A rejection nothing handled and an exception nothing caught both leave the
 * connector in a state it cannot describe, so both take the same path as a
 * signal — with a non-zero code, so that whatever supervises this process can
 * tell a crash from a clean stop.
 *
 * @param options - What to stop, where to log, and which emitter to listen on.
 */
export function registerShutdownHandlers(options: ShutdownHandlerOptions): void {
  const { connector, logger } = options;
  const target = options.target ?? process;

  target.on('SIGINT', (signal: NodeJS.Signals) => {
    connector.stop(signal, 0);
  });
  target.on('SIGTERM', (signal: NodeJS.Signals) => {
    connector.stop(signal, 0);
  });

  target.on('unhandledRejection', (reason: unknown) => {
    logger.error({ error: describeError(reason) }, 'unhandled promise rejection');
    connector.stop('unhandledRejection', 1);
  });

  target.on('uncaughtException', (error: Error) => {
    logger.error({ error: describeError(error) }, 'uncaught exception');
    connector.stop('uncaughtException', 1);
  });
}

/**
 * Whose problem a start-up failure is.
 *
 * Named in the one line a merchant reads when the connector will not start,
 * because the four cases call for four completely different next moves and
 * "cannot start" on its own tells them none of it.
 */
export type StartupFault =
  /** The arguments or environment are wrong. The merchant fixes this. */
  | 'configuration'
  /** The token was refused. The merchant re-copies or re-issues it; waiting will not help. */
  | 'credential'
  /** The endpoint could not be reached. Nobody's configuration is wrong; the service or the network is down. */
  | 'endpoint'
  /** Anything else, which means a defect in this connector. */
  | 'connector';

/**
 * Classify a start-up failure.
 *
 * @param error - What `startConnector` or `resolveConfig` threw.
 * @returns Which of the four situations this is.
 */
export function faultOf(error: unknown): StartupFault {
  if (error instanceof ConnectorConfigError) {
    return 'configuration';
  }
  if (error instanceof RemoteConnectionError) {
    return isPermanentFailure(error.kind) ? 'credential' : 'endpoint';
  }
  return 'connector';
}

export interface MainOptions {
  /** Defaults to `process.argv.slice(2)`. */
  readonly argv?: readonly string[] | undefined;
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly stdin?: Readable | undefined;
  readonly stdout?: Writable | undefined;
  /** Where log lines go. Defaults to a synchronous write to stderr. */
  readonly write?: ((line: string) => void) | undefined;
  /**
   * Where the `doctor` report goes. Defaults to a synchronous write to stdout.
   *
   * Separate from `write` on purpose: they are different streams for different
   * audiences, and a test that asserts the report never reaches the protocol
   * channel has to be able to tell them apart.
   */
  readonly writeReport?: ((text: string) => void) | undefined;
  /** Defaults to `process.versions.node`. Injected so a test can drive an unsupported runtime. */
  readonly nodeVersion?: string | undefined;
  /** Defaults to `process.argv[1]`. Only `doctor` reads it. */
  readonly binaryPath?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly retry?: RetryPolicy | undefined;
  readonly signalTarget?: SignalTarget | undefined;
}

/**
 * Run the connector to completion.
 *
 * Never throws: a start-up failure is reported as one actionable line and a
 * non-zero code, because the only thing above this is a hashbang.
 *
 * @param options - Overrides for everything this would otherwise read from `process`.
 * @returns The exit code the process should leave with.
 */
export async function main(options: MainOptions = {}): Promise<number> {
  // Built before the configuration is read, so that a configuration failure has
  // somewhere to be reported. It knows no secrets because none has been
  // resolved yet — and `resolveConfig` never puts a value it read into the
  // error it throws.
  let logger = createLogger({
    name: CONNECTOR_NAME,
    level: DEFAULT_LOG_LEVEL,
    ...(options.write === undefined ? {} : { write: options.write }),
  });

  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;

  try {
    // Before the Node check, deliberately. `doctor` reports an unsupported
    // runtime as one line of a report a merchant can read and paste, which is
    // strictly more useful than the same sentence on its own — and a merchant
    // whose connector will not start is exactly who runs it.
    const doctorArgv = takeDoctorSubcommand(argv);
    if (doctorArgv !== undefined) {
      const report = await runDoctor({
        argv: doctorArgv,
        env,
        nodeVersion,
        ...(options.binaryPath === undefined ? {} : { binaryPath: options.binaryPath }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      (options.writeReport ?? writeToStandardOutput)(report.text);
      return report.exitCode;
    }

    // `engines.node` in the manifest is advisory — npm warns rather than
    // refusing unless the installer set `engine-strict` — so the floor is
    // enforced here, where the message can say so.
    if (!isSupportedNode(nodeVersion)) {
      throw new ConnectorConfigError(unsupportedNodeMessage(nodeVersion));
    }

    const config = resolveConfig(argv, env);
    logger = createConnectorLogger(config, options.write);

    for (const warning of config.warnings) {
      logger.warn({}, warning);
    }

    const connector = await startConnector({
      config,
      logger,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
    });

    registerShutdownHandlers({
      connector,
      logger,
      ...(options.signalTarget === undefined ? {} : { target: options.signalTarget }),
    });

    return await connector.stopped;
  } catch (error: unknown) {
    // Every expected failure is already one actionable sentence. What the fault
    // adds is whose move it is next, which the sentence alone cannot say: a
    // refused token and an unreachable endpoint read almost the same and are
    // not remotely the same problem.
    logger.error({ reason: describeError(error), fault: faultOf(error) }, `${CONNECTOR_NAME} cannot start`);
    return 1;
  }
}
