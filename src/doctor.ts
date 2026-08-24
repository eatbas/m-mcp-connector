import { realpathSync } from 'node:fs';

import { ListToolsRequestSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { ConnectorConfigError, resolveConfig, TOKEN_ENV_VAR } from './config.js';
import { describeError, redactSecrets, TOKEN_QUERY_PARAMETER } from './diagnostics.js';
import { createLogger } from './logger.js';
import { isSupportedNode, MINIMUM_NODE_MAJOR, unsupportedNodeMessage } from './node-version.js';
import { connectRemote, isPermanentFailure, RemoteConnectionError } from './remote.js';
import type { RetryPolicy } from './remote.js';
import { CONNECTOR_NAME, CONNECTOR_VERSION } from './version.js';

/**
 * `m-mcp-connector doctor` — what a merchant runs when it will not start.
 *
 * ── The failure this exists for ──────────────────────────────────────────────
 *
 * This package is installed globally, and its `command` in an MCP client's
 * configuration is the bare name `m-mcp-connector`. A GUI-launched client on
 * macOS inherits a minimal PATH — `/usr/bin:/bin:/usr/sbin:/sbin` and little
 * else — so a Node installed through nvm or Homebrew is invisible to it, and
 * the bare name fails with an `ENOENT` that names no cause and suggests no fix.
 * The workaround is an absolute path in `command`, and the thing a merchant
 * cannot easily obtain is that absolute path.
 *
 * So the first line of this report is the path, and the last is a configuration
 * block already built around it. Everything between is what a support reply
 * would otherwise have to ask for, one round trip at a time.
 *
 * ── Why writing to stdout is safe here, and only here ────────────────────────
 *
 * Everywhere else in this package stdout is the JSON-RPC channel and a stray
 * byte desynchronises the client for the rest of the session. `doctor` runs
 * *instead of* a session: it is intercepted in `main()` before `resolveConfig`,
 * never connects the stdio transport, and exits when the report is written.
 * There is no framing to corrupt. `logger.ts` owns the write itself, through
 * the one sanctioned `writeToStandardOutput`.
 *
 * ── What it never prints ─────────────────────────────────────────────────────
 *
 * The token. Its presence, its transport and its absence are all reportable and
 * all useful; its value is not, and a merchant pasting a diagnostic report into
 * an issue is exactly the moment it would leak. The endpoint is printed by
 * origin and path only, for the same reason — a URL that once carried `?p=`
 * must not be echoed back.
 *
 * That is the intent, and no call site here defeats it. The guarantee is the
 * pass through {@link redactSecrets} in {@link runDoctor}, which is the same
 * second line of defence `logger.ts` puts behind every line the connector
 * writes — and for the same reason it gives: a credential that arrives inside
 * something else, an error message or a URL in a `cause`, is exactly the route
 * a review cannot check by reading call sites. `doctor` builds the one output a
 * merchant is actively told to paste somewhere public, so it is the last place
 * to rely on intent alone.
 */

/** The subcommand, as a merchant types it. */
export const DOCTOR_COMMAND = 'doctor';

/**
 * Take `doctor` off the argument list, when that is what was asked for.
 *
 * It has to come off rather than be passed through. `config.ts` treats the
 * first non-flag argument as the endpoint URL, so a `doctor` left in place is
 * reported as a malformed endpoint — the least helpful possible answer to a
 * request for help.
 *
 * The subcommand must be the first *positional* argument. Flags are skipped
 * rather than refused, matching `positionalArguments` in `config.ts`: this
 * process is spawned by an MCP client whose argument list is only partly under
 * the merchant's control.
 *
 * @param argv - Arguments after the executable and script path.
 * @returns The remaining arguments when `doctor` was asked for, or undefined when it was not.
 */
export function takeDoctorSubcommand(argv: readonly string[]): readonly string[] | undefined {
  const index = argv.findIndex((argument) => !argument.startsWith('-'));

  if (index === -1 || argv[index] !== DOCTOR_COMMAND) {
    return undefined;
  }

  return [...argv.slice(0, index), ...argv.slice(index + 1)];
}

/** How long the live check may take before it is treated as unreachable. */
const DOCTOR_RETRY: RetryPolicy = { attempts: 1, initialDelayMs: 0, growthFactor: 1, maximumDelayMs: 0 };

export interface DoctorOptions {
  /** Arguments after `doctor` has been removed, i.e. what `resolveConfig` should see. */
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Defaults to `process.versions.node`. Injected so a test can drive an unsupported runtime. */
  readonly nodeVersion?: string | undefined;
  /** Defaults to `process.argv[1]`, the path the client actually launched. */
  readonly binaryPath?: string | undefined;
  /** Injected so a test answers the endpoint in process, and can assert the network was never touched. */
  readonly fetch?: FetchLike | undefined;
}

export interface DoctorReport {
  /** 0 when the connector would start and the endpoint answered; non-zero otherwise. */
  readonly exitCode: number;
  /** The whole report, newline-terminated, ready to write. */
  readonly text: string;
  /** Whose move it is next, matching `run.ts`'s taxonomy. Absent when nothing failed. */
  readonly fault?: 'configuration' | 'credential' | 'endpoint' | 'connector';
}

/**
 * The absolute path of the running binary, resolved through any symlink.
 *
 * A global npm install may put a symlink on PATH and the real entry point in the
 * installation prefix. Resolve it through `realpath` so the report always
 * carries an absolute executable path and a broken link is reported as such
 * rather than printed as though it worked.
 *
 * @param binaryPath - `process.argv[1]`, or whatever a test supplied.
 * @returns The path to put in `command`, and whether it resolves.
 */
function describeBinary(binaryPath: string | undefined): { readonly path: string; readonly resolves: boolean } {
  if (binaryPath === undefined || binaryPath.trim() === '') {
    return { path: '(unknown: this process was started without a script path)', resolves: false };
  }

  try {
    return { path: realpathSync(binaryPath), resolves: true };
  } catch {
    return { path: binaryPath, resolves: false };
  }
}

/**
 * The configuration block a merchant pastes, built around an absolute path.
 *
 * The token is a placeholder rather than the resolved value: this report is
 * written to be pasted into an issue as often as into a configuration file.
 *
 * @param commandPath - What to put in `command`.
 * @returns Pretty-printed JSON, without a trailing newline.
 */
function configurationBlock(commandPath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'm-mcp': {
          command: commandPath,
          env: { [TOKEN_ENV_VAR]: '<the token the console showed you>' },
        },
      },
    },
    null,
    2,
  );
}

/**
 * Run the live half: connect under the resolved token and count the tools.
 *
 * `tools/list` rather than the handshake alone, because a token that
 * authenticates but grants nothing produces an empty list and no error, and
 * "connected, 0 tools" is the diagnosis in that case rather than a success.
 *
 * @param options - The resolved configuration and the injectable `fetch`.
 * @returns The lines to append, and the exit code and fault they imply.
 */
async function checkEndpoint(
  options: DoctorOptions,
): Promise<{ readonly lines: string[]; readonly exitCode: number; readonly fault?: DoctorReport['fault'] }> {
  const config = resolveConfig(options.argv, options.env);
  // Silent: the report is the output, and a second stream of log records
  // interleaved with it would be the noise this command exists to replace. The
  // secret is registered all the same, so that anything this logger is asked to
  // write at a louder level is scrubbed like every other line in the package.
  const logger = createLogger({ name: CONNECTOR_NAME, level: 'silent', secrets: [config.token] });

  const remote = await connectRemote({
    endpoint: config.endpoint,
    token: config.token,
    logger,
    retry: DOCTOR_RETRY,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  try {
    const result = await remote.forward(
      { method: ListToolsRequestSchema.shape.method.value, params: {} },
      ListToolsResultSchema,
      {},
    );
    const names = result.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));

    return {
      lines: [
        `Endpoint:      ${remote.label}`,
        `Token:         present, from the ${config.tokenSource === 'environment' ? TOKEN_ENV_VAR : 'endpoint URL'}`,
        `Connector:     ${CONNECTOR_NAME} ${CONNECTOR_VERSION}${remote.latestConnectorVersion === undefined ? '' : `; endpoint advertises ${remote.latestConnectorVersion}`}`,
        `Handshake:     accepted by ${remote.serverInfo?.name ?? 'the endpoint'} ${remote.serverInfo?.version ?? ''}`.trimEnd(),
        `Tools:         ${String(names.length)}${names.length === 0 ? ' — the token authenticates but grants nothing' : ` (${names.join(', ')})`}`,
      ],
      exitCode: names.length === 0 ? 1 : 0,
      ...(names.length === 0 ? { fault: 'credential' as const } : {}),
    };
  } finally {
    await remote.close();
  }
}

/**
 * Whose move it is next, for a failure the live check raised.
 *
 * The same four situations `run.ts`'s `faultOf` separates, decided the same
 * way. They are not shared because `faultOf` classifies what stopped a session
 * starting and this classifies what stopped a report completing, and the day
 * those diverge the shared function would have to grow a flag.
 *
 * @param error - What `checkEndpoint` threw.
 * @returns The fault to print.
 */
function classifyDoctorFault(error: unknown): NonNullable<DoctorReport['fault']> {
  if (error instanceof ConnectorConfigError) {
    return 'configuration';
  }
  if (error instanceof RemoteConnectionError) {
    return isPermanentFailure(error.kind) ? 'credential' : 'endpoint';
  }
  return 'connector';
}

/**
 * Run the live check, and turn whatever it threw into report lines.
 *
 * Never throws: `runDoctor` promises a report on every path, and a report that
 * crashed instead of printing would be worse than the failure it exists to
 * explain.
 *
 * @param options - Arguments after `doctor`, the environment, and the test seams.
 * @returns Lines to append, the exit code, and the fault when there was one.
 */
async function attemptEndpoint(
  options: DoctorOptions,
): Promise<{ readonly lines: string[]; readonly exitCode: number; readonly fault?: DoctorReport['fault'] }> {
  try {
    return await checkEndpoint(options);
  } catch (error: unknown) {
    return {
      lines: ['Endpoint:      not reached', '', describeError(error)],
      exitCode: 1,
      fault: classifyDoctorFault(error),
    };
  }
}

/**
 * Every value that must not appear in the report.
 *
 * Collected from this command's **inputs** rather than from the resolved
 * configuration, deliberately. Resolution is one of the things that fails — a
 * malformed token never becomes a `config.token` — and the failure paths are
 * precisely the ones a merchant pastes into an issue. Reading the environment
 * and the argument list directly means the scrub does not depend on the step
 * that went wrong.
 *
 * `redactSecrets` ignores anything too short to be a credential, so a blank
 * variable, a placeholder, or a URL with no `?p=` all cost nothing here.
 *
 * @param options - The environment and arguments `doctor` was given.
 * @returns Every candidate credential, with empties dropped.
 */
function secretsIn(options: DoctorOptions): readonly string[] {
  const candidates: string[] = [options.env[TOKEN_ENV_VAR] ?? ''];

  for (const argument of options.argv) {
    try {
      candidates.push(new URL(argument).searchParams.get(TOKEN_QUERY_PARAMETER) ?? '');
    } catch {
      // Not an absolute URL, so it carries no `?p=`. What that means for the
      // run is `resolveConfig`'s decision, not this function's.
    }
  }

  return candidates.filter((value) => value.trim() !== '');
}

/**
 * Build the whole report.
 *
 * Never throws: every failure it can meet is one of the four faults, and a
 * report that crashed instead of printing would be worse than the ENOENT it
 * exists to explain.
 *
 * @param options - Arguments after `doctor`, the environment, and the test seams.
 * @returns The text to write and the code to exit with.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const binary = describeBinary(options.binaryPath ?? process.argv[1]);
  const nodeSupported = isSupportedNode(nodeVersion);

  const lines: string[] = [
    `${CONNECTOR_NAME} ${CONNECTOR_VERSION}`,
    '',
    `Binary:        ${binary.path}`,
    `Node:          ${nodeVersion}${nodeSupported ? '' : ` — too old, ${String(MINIMUM_NODE_MAJOR)} or newer is needed`}`,
  ];

  if (!binary.resolves) {
    lines.push('               ^ this path does not resolve on disk; the install may be broken or incomplete');
  }

  const outcome = nodeSupported
    ? await attemptEndpoint(options)
    : { lines: ['', unsupportedNodeMessage(nodeVersion)], exitCode: 1, fault: 'configuration' as const };

  lines.push(
    ...outcome.lines,
    '',
    'Configuration for a client that cannot find the binary on its PATH:',
    '',
    configurationBlock(binary.path),
  );

  const { fault } = outcome;
  if (fault !== undefined) {
    lines.push('', `Fault: ${fault} — ${FAULT_ADVICE[fault]}`);
  }

  // The guarantee, not a formality: everything above is assembled from strings
  // this module chose, except `describeError`, which returns whatever the SDK,
  // the runtime or a dependency put in a message. This is the pass that makes
  // the token's absence a property of the output rather than of the call sites.
  const text = redactSecrets(`${lines.join('\n')}\n`, secretsIn(options));

  return { exitCode: outcome.exitCode, text, ...(fault === undefined ? {} : { fault }) };
}

/** What each fault means for the reader, in the words `run.ts` uses for the same four. */
const FAULT_ADVICE: Readonly<Record<NonNullable<DoctorReport['fault']>, string>> = {
  configuration: 'yours to fix; the message above names the setting.',
  credential: 'the token was refused or grants nothing. Re-copy it, or ask for a new one.',
  endpoint: 'nothing you configured is wrong; the service could not be reached from this machine.',
  connector: 'a defect in this package. Worth reporting with this report attached.',
};
