import { z } from 'zod';

import { TOKEN_QUERY_PARAMETER } from './diagnostics.js';
import { LOG_LEVEL_ENV_VAR, LOG_LEVELS, resolveLogLevel } from './logger.js';
import type { LogLevel } from './logger.js';

/**
 * Everything this process needs, resolved once from the arguments and the
 * environment the MCP client spawned it with.
 *
 * ── The two ways to present a token, and no third ────────────────────────────
 *
 * The endpoint accepts a token as `Authorization: Bearer` or as `?p=` in the
 * URL, and the reason the query parameter exists is recorded in
 * `apps/mcp/src/auth/token.ts`: the reference consumer passes a URL and has
 * nowhere to put a header. This connector therefore accepts:
 *
 *   1. `M_MCP_TOKEN` in the environment — the form to prefer, and the form the
 *      admin console emits, because an MCP client's `env` block is not visible
 *      to other processes on the machine.
 *   2. `?p=<token>` inside the endpoint URL — the form a merchant already has,
 *      because it is the URL the console shows them.
 *
 * There is deliberately no `--token=` flag. Every argument a process was
 * started with is readable by anything else on the machine through `ps` and
 * `/proc/<pid>/cmdline`, and a flag adds that exposure without buying a single
 * client configuration that the two forms above cannot already express. A URL
 * argument carrying `?p=` has the same exposure, which is why the environment
 * wins when both are present.
 *
 * ── The token is taken out of the URL, always ────────────────────────────────
 *
 * Whichever form it arrived in, the token leaves this process in one place: the
 * `Authorization` header `remote.ts` sets. {@link resolveConfig} strips `p` from
 * the endpoint before anything can send it, so the credential never reaches the
 * hosted service's access log, the reverse proxy's access log, or any error
 * message that happens to quote a URL.
 *
 * ── No `.env` is ever loaded ─────────────────────────────────────────────────
 *
 * An MCP client spawns this connector with the merchant's own workspace as the
 * working directory. A dotenv loader would silently adopt whatever credentials
 * that project happens to hold — possibly production ones for something else
 * entirely. Which environment is in play must always be a decision, never a
 * side effect.
 */

/** Where the hosted endpoint runs. Matches the Traefik rule in `docker-compose.coolify.yml`. */
export const DEFAULT_ENDPOINT_URL = 'https://m-mcp.atbas.xyz/mcp';

/** Environment variable carrying the merchant's access token. */
export const TOKEN_ENV_VAR = 'M_MCP_TOKEN';

/** Environment variable overriding the endpoint, for a self-hosted or local deployment. */
export const URL_ENV_VAR = 'M_MCP_URL';

/**
 * The shape a token must have before this connector will present it.
 *
 * Character for character the `TOKEN_SHAPE` in `apps/mcp/src/auth/token.ts`,
 * and it must never be made stricter than that one: a connector that refuses a
 * token the service would have accepted locks a merchant out of their own
 * account with no way to tell why. Checking it locally turns a truncated
 * copy-paste into an explanatory start-up failure rather than a 401, which a
 * merchant reasonably reads as "my token was revoked" and escalates.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._~-]{16,512}$/;

/**
 * `http` is accepted alongside `https` because a self-hosted deployment and the
 * development stack both run on `http://localhost:3200/mcp`. Production is HTTPS
 * and {@link DEFAULT_ENDPOINT_URL} reflects that.
 */
const endpointUrlSchema = z.url({ protocol: /^https?$/ });

/** Which transport the token arrived on. Recorded for the start-up line; never the value. */
export type TokenSource = 'environment' | 'url';

export interface ConnectorConfig {
  /**
   * The endpoint to proxy to, with any `?p=` already removed.
   *
   * A `URL` rather than a string, because every consumer needs the parsed form
   * and re-parsing it downstream is a second chance to get the stripping wrong.
   */
  readonly endpoint: URL;
  /** The merchant's access token. Never logged, never interpolated into a message. */
  readonly token: string;
  readonly tokenSource: TokenSource;
  readonly logLevel: LogLevel;
  /**
   * Configuration problems that do not stop the connector from starting.
   *
   * Each entry is one actionable sentence, already safe to print: `run.ts`
   * writes them to stderr once the logger exists. Collected here rather than
   * logged here so that resolving the configuration stays a pure function of
   * its two inputs.
   */
  readonly warnings: readonly string[];
}

/**
 * A configuration failure the merchant has to fix.
 *
 * Exported so the entry point can tell an operator mistake — which deserves one
 * actionable line and a non-zero exit — from a genuine crash. No message raised
 * here carries the value of the setting it names, because that value may be the
 * token.
 */
export class ConnectorConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Treat a blank value as absent.
 *
 * MCP client configurations routinely carry placeholder entries such as
 * `"M_MCP_TOKEN": ""`. A blank token must produce the "no token configured"
 * message rather than the "malformed token" one, because they call for
 * completely different fixes. Values are trimmed because a token pasted from a
 * terminal frequently arrives with a trailing newline.
 */
function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Arguments that are not flags, in the order they were given.
 *
 * Anything beginning with `-` is ignored rather than refused. This process is
 * spawned by an MCP client whose argument list is only partly under the
 * merchant's control, so an argument this connector does not recognise must not
 * be able to stop it from starting.
 */
function positionalArguments(argv: readonly string[]): readonly string[] {
  return argv.filter((argument) => !argument.startsWith('-'));
}

/** The endpoint text, before it is validated or stripped. */
function readEndpointText(argv: readonly string[], env: NodeJS.ProcessEnv, warnings: string[]): string {
  const positionals = positionalArguments(argv);
  const [first] = positionals;

  if (positionals.length > 1) {
    warnings.push(
      `Only the first URL argument is used; ${String(positionals.length - 1)} further argument(s) were ignored.`,
    );
  }

  return blankToUndefined(first) ?? blankToUndefined(env[URL_ENV_VAR]) ?? DEFAULT_ENDPOINT_URL;
}

/**
 * Validate the endpoint and take the token out of it.
 *
 * @returns The endpoint with every `p` parameter removed, and the token it carried.
 * @throws {ConnectorConfigError} If the endpoint is not an absolute http or https URL.
 */
function readEndpoint(endpointText: string): { readonly endpoint: URL; readonly token: string | undefined } {
  // zod decides, and its parsed output is then discarded: a zod issue carries
  // the offending `input`, and the input here is the one string a merchant may
  // have pasted a token into. Only this module's own message reaches stderr.
  if (!endpointUrlSchema.safeParse(endpointText).success) {
    throw new ConnectorConfigError(
      `Invalid endpoint URL. Pass an absolute http or https URL as the first argument, or set ${URL_ENV_VAR} — ` +
        `for example ${DEFAULT_ENDPOINT_URL}.`,
    );
  }

  const endpoint = new URL(endpointText);
  const token = blankToUndefined(endpoint.searchParams.get(TOKEN_QUERY_PARAMETER) ?? undefined);

  // `delete` removes every occurrence, so a URL carrying the parameter twice
  // leaves nothing behind for the transport to send.
  endpoint.searchParams.delete(TOKEN_QUERY_PARAMETER);

  return { endpoint, token };
}

/**
 * Decide which token is presented, and refuse one that cannot possibly work.
 *
 * @throws {ConnectorConfigError} If no token was supplied, or the supplied one is the wrong shape.
 */
function readToken(
  env: NodeJS.ProcessEnv,
  urlToken: string | undefined,
  warnings: string[],
): { readonly token: string; readonly tokenSource: TokenSource } {
  const environmentToken = blankToUndefined(env[TOKEN_ENV_VAR]);

  if (environmentToken !== undefined && urlToken !== undefined && environmentToken !== urlToken) {
    // Comparing two caller-supplied strings in memory discloses nothing, and
    // saying which one won is the difference between a merchant who rotates
    // their token in one place and one who cannot work out why the old one is
    // still being used.
    warnings.push(
      `Two different tokens were supplied: ${TOKEN_ENV_VAR} is being used and the one in the URL is ignored. ` +
        'Remove whichever is stale.',
    );
  }

  const token = environmentToken ?? urlToken;

  if (token === undefined) {
    throw new ConnectorConfigError(
      `No access token. Set ${TOKEN_ENV_VAR}, or pass the endpoint URL with its ?${TOKEN_QUERY_PARAMETER}= parameter ` +
        'exactly as the console showed it. Every tool this connector serves is served by the hosted endpoint, so ' +
        'there is nothing it can do without one.',
    );
  }

  if (!TOKEN_SHAPE.test(token)) {
    throw new ConnectorConfigError(
      'Malformed access token. Copy it again exactly as it was shown when it was issued — a truncated paste is the ' +
        `usual cause. It is checked here rather than at the endpoint so that the message names ${TOKEN_ENV_VAR} ` +
        'instead of arriving as an authentication failure.',
    );
  }

  return { token, tokenSource: environmentToken === undefined ? 'url' : 'environment' };
}

/**
 * Resolve the connector's configuration.
 *
 * @param argv - Arguments after the executable and script path, i.e. `process.argv.slice(2)`.
 * @param env - The environment to read. Injected rather than taken from `process.env` so tests need no global state.
 * @returns The endpoint, the token, the verbosity, and any non-fatal complaints about the three.
 * @throws {ConnectorConfigError} If the endpoint or the token is missing or malformed.
 */
export function resolveConfig(argv: readonly string[], env: NodeJS.ProcessEnv): ConnectorConfig {
  const warnings: string[] = [];

  const { endpoint, token: urlToken } = readEndpoint(readEndpointText(argv, env, warnings));
  const { token, tokenSource } = readToken(env, urlToken, warnings);
  const { level, recognised } = resolveLogLevel(env[LOG_LEVEL_ENV_VAR]);

  if (!recognised) {
    warnings.push(`${LOG_LEVEL_ENV_VAR} is not one of ${LOG_LEVELS.join(', ')}; logging at ${level} instead.`);
  }

  return { endpoint, token, tokenSource, logLevel: level, warnings };
}
