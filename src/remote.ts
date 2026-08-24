import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AnySchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Implementation, Request, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

import { describeCause, describeEndpoint } from './diagnostics.js';
import type { Logger } from './logger.js';
import { createUpgradeNotifier, LATEST_VERSION_HEADER } from './upgrade.js';
import { CONNECTOR_NAME, CONNECTOR_VERSION } from './version.js';

/**
 * The hosted endpoint, as one object the bridge can forward to.
 *
 * ── What this connector is for ───────────────────────────────────────────────
 *
 * Every tool, resource and prompt lives at the hosted endpoint, where it can be
 * scoped, metered and revoked per token. Nothing is served locally, so unlike a
 * bridge with a local half there is no degraded mode worth offering: a
 * connector that cannot reach the endpoint has nothing to answer with, and
 * saying so and exiting is more useful to a merchant than a tool list that is
 * silently empty.
 *
 * ── Two rules that are load-bearing ──────────────────────────────────────────
 *
 *  1. **A request is never retried.** Only the initial connection is attempted
 *     more than once, and only while the endpoint has not refused the
 *     credential. A forwarded call that failed may have been served, metered and
 *     counted against the merchant's quota; re-sending it would bill them twice
 *     for one question.
 *  2. **The token is never logged.** It is interpolated into one `Authorization`
 *     header and read nowhere else. Endpoints are described by origin and path
 *     only, so a URL that once carried `?p=` cannot be echoed back either — and
 *     `config.ts` has already stripped that parameter before this module sees
 *     the URL.
 */

/** HTTP statuses this connector explains rather than reports verbatim. */
const UNAUTHENTICATED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const RATE_LIMITED_STATUS = 429;

const LOWEST_HTTP_STATUS = 100;
const HIGHEST_HTTP_STATUS = 599;

/**
 * `ErrorCode.ConnectionClosed` as a plain number.
 *
 * `McpError.code` is declared `number` rather than the enum, so comparing the
 * two directly is the enum misuse ESLint refuses. Widening once here keeps the
 * comparison honest without an assertion at each call site.
 */
const CONNECTION_CLOSED_CODE: number = ErrorCode.ConnectionClosed;

/** How the initial connection is re-attempted. */
export interface RetryPolicy {
  /** Total attempts, including the first. Must be at least 1; this is what bounds the loop. */
  readonly attempts: number;
  readonly initialDelayMs: number;
  readonly growthFactor: number;
  readonly maximumDelayMs: number;
}

/**
 * Three attempts over roughly three seconds.
 *
 * Bounded rather than indefinite, and short rather than patient, because of
 * when it runs: an MCP client starts every configured server at once, shows the
 * merchant a spinner, and a connector still retrying after ten seconds looks
 * broken. What this budget is actually for is the laptop that has just woken up
 * and whose network is a second behind the application — not an outage, which
 * no amount of waiting inside a start-up path will fix.
 */
export const DEFAULT_CONNECT_RETRY: RetryPolicy = {
  attempts: 3,
  initialDelayMs: 1_000,
  growthFactor: 2,
  maximumDelayMs: 8_000,
};

/** How a hosted failure is explained, and what the connector does about it. */
export type RemoteFailureKind = 'unauthorised' | 'forbidden' | 'rateLimited' | 'unreachable' | 'protocol';

export interface RemoteFailure {
  readonly kind: RemoteFailureKind;
  /** One actionable sentence, safe to print. Never carries the token. */
  readonly message: string;
}

/**
 * The connector could not reach, or was not admitted by, the hosted endpoint.
 *
 * Carries the classification as well as the sentence so that the entry point
 * can distinguish a refusal the merchant must act on from an outage they can
 * only wait out, and report a start-up failure as one actionable line rather
 * than a stack trace.
 */
export class RemoteConnectionError extends Error {
  public readonly kind: RemoteFailureKind;

  public constructor(failure: RemoteFailure) {
    super(failure.message);
    this.name = new.target.name;
    this.kind = failure.kind;
  }
}

export interface RemoteEndpoint {
  /** Origin and path of the endpoint. Safe to print: it carries no query string. */
  readonly label: string;
  /** Capabilities the endpoint reported at `initialize`. */
  readonly capabilities: ServerCapabilities;
  /** The endpoint's own identity, forwarded downstream so a client names the real service. */
  readonly serverInfo: Implementation | undefined;
  /** The newest connector version advertised by the endpoint during this connection. */
  readonly latestConnectorVersion: string | undefined;
  /** The endpoint's own guidance, forwarded downstream unchanged. */
  readonly instructions: string | undefined;
  /**
   * Forward one request and return the endpoint's answer.
   *
   * @param request - The request as the downstream client sent it.
   * @param resultSchema - Schema the answer is validated against.
   * @param options - The caller's abort signal, and anything else per-request.
   * @throws {McpError} An error the endpoint itself returned, unchanged; otherwise one explaining the transport
   *   failure in a sentence a merchant can act on. Never retried, whichever it is.
   */
  forward<Schema extends AnySchema>(
    request: Request,
    resultSchema: Schema,
    options: RequestOptions,
  ): Promise<SchemaOutput<Schema>>;
  close(): Promise<void>;
}

export interface ConnectRemoteOptions {
  /** Absolute endpoint URL with `?p=` already stripped, as `resolveConfig` returns it. */
  readonly endpoint: URL;
  readonly token: string;
  readonly logger: Logger;
  /** Injected so tests answer the endpoint in process, and can assert the network was never touched. */
  readonly fetch?: FetchLike | undefined;
  /** Overridable so a test does not wait real seconds on a retry. */
  readonly retry?: RetryPolicy | undefined;
}

/**
 * `Retry-After` in whole seconds, or `undefined`.
 *
 * Only the delta-seconds form is read. The HTTP-date form is legal but this
 * project's endpoint never sends it, and a wrong number in an instruction is
 * worse than no number: without one the message says "shortly" instead.
 */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const seconds = Number.parseInt(header.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

interface EndpointProbe {
  /** The `fetch` handed to the transport. */
  readonly fetch: FetchLike;
  /** `Retry-After` from the most recent refusal, when that refusal carried `status`. */
  retryAfterFor(status: number): number | undefined;
  /** The most recent non-empty connector version advertised by the endpoint. */
  latestConnectorVersion(): string | undefined;
}

/** What a probe needs beyond the caller's `fetch`. */
interface EndpointProbeOptions {
  /** Where the upgrade advice goes, at most once per process. See `upgrade.ts`. */
  readonly logger: Logger;
}

/**
 * Wrap `fetch` so a refusal's `Retry-After` survives into the message.
 *
 * The SDK raises a `StreamableHTTPError` carrying the status and nothing else,
 * and "retry after 30 seconds" is the difference between an instruction and a
 * complaint. The recorded value is matched against the status of the failure
 * being explained, so a stale header from an earlier, different refusal cannot
 * be attributed to this one. With several requests in flight the pairing is
 * best effort; it decorates a message and decides nothing.
 */
function createEndpointProbe(baseFetch: FetchLike | undefined, options: EndpointProbeOptions): EndpointProbe {
  const perform: FetchLike = baseFetch ?? ((url, init): Promise<Response> => fetch(url, init));
  let lastRefusal: { readonly status: number; readonly retryAfterSeconds: number | undefined } | undefined;
  let latestConnectorVersion: string | undefined;
  const notifyOfUpgrade = createUpgradeNotifier();

  return {
    fetch: async (url, init): Promise<Response> => {
      const response = await perform(url, init);
      if (!response.ok) {
        lastRefusal = {
          status: response.status,
          retryAfterSeconds: parseRetryAfterSeconds(response.headers.get('retry-after')),
        };
      }

      // Read off every response, refusals included: a 429 still tells the truth
      // about which version is current, and the merchant reading a rate-limit
      // line is exactly the merchant who should also hear that their connector
      // is a year old.
      const advertisedVersion = response.headers.get(LATEST_VERSION_HEADER)?.trim();
      if (advertisedVersion !== undefined && advertisedVersion !== '') {
        latestConnectorVersion = advertisedVersion;
      }
      const advice = notifyOfUpgrade(advertisedVersion ?? null);
      if (advice !== undefined) {
        options.logger.warn({}, advice);
      }

      return response;
    },
    retryAfterFor: (status): number | undefined =>
      lastRefusal?.status === status ? lastRefusal.retryAfterSeconds : undefined,
    latestConnectorVersion: (): string | undefined => latestConnectorVersion,
  };
}

/** HTTP status behind a transport failure, when there was one. */
function httpStatusOf(error: unknown): number | undefined {
  if (!(error instanceof StreamableHTTPError)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'number' && code >= LOWEST_HTTP_STATUS && code <= HIGHEST_HTTP_STATUS ? code : undefined;
}

/**
 * Explain a hosted failure in one actionable sentence.
 *
 * @param error - What the transport or the SDK threw.
 * @param endpoint - Endpoint label from `describeEndpoint`; safe to print.
 * @param retryAfterSeconds - `Retry-After` observed alongside a 429, when the endpoint sent one.
 * @returns The classification the connector acts on, and the sentence it prints.
 */
export function classifyRemoteFailure(
  error: unknown,
  endpoint: string,
  retryAfterSeconds: number | undefined,
): RemoteFailure {
  const status = httpStatusOf(error);

  if (status === UNAUTHENTICATED_STATUS) {
    return {
      kind: 'unauthorised',
      message: `${endpoint} did not accept this access token. Check it was copied in full, and that it has not been revoked.`,
    };
  }

  if (status === FORBIDDEN_STATUS) {
    return {
      kind: 'forbidden',
      message: `${endpoint} refused this access token. It has been revoked or has expired; issue a new one from the console.`,
    };
  }

  if (status === RATE_LIMITED_STATUS) {
    return {
      kind: 'rateLimited',
      message:
        retryAfterSeconds === undefined
          ? `${endpoint} is rate limiting this token. Retry shortly.`
          : `${endpoint} is rate limiting this token. Retry after ${String(retryAfterSeconds)} seconds.`,
    };
  }

  if (status !== undefined) {
    return { kind: 'protocol', message: `${endpoint} answered HTTP ${String(status)}.` };
  }

  if (error instanceof McpError) {
    return error.code === CONNECTION_CLOSED_CODE
      ? { kind: 'unreachable', message: `The connection to ${endpoint} closed.` }
      : { kind: 'protocol', message: `${endpoint} returned a response this connector could not read.` };
  }

  return { kind: 'unreachable', message: `${endpoint} could not be reached (${describeCause(error)}).` };
}

/** True when re-attempting would only repeat a refusal the merchant has to act on. */
export function isPermanentFailure(kind: RemoteFailureKind): boolean {
  return kind === 'unauthorised' || kind === 'forbidden';
}

/** True when the caller cancelled, rather than the endpoint failing. */
function wasAborted(error: unknown, options: RequestOptions): boolean {
  return options.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

/** Resolve after `delayMs`. The timer is not unreferenced: nothing else is keeping start-up alive. */
function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * One connection to the endpoint, for the lifetime of the process.
 *
 * There is deliberately no reconnection logic and no "the connection dropped"
 * callback, and the reason is a property of the endpoint rather than an
 * omission here. It runs its Streamable HTTP transport statelessly with
 * `enableJsonResponse: true`, so there is no session and no open stream: every
 * message is one POST answered by one JSON body. A network failure therefore
 * fails the request it happened to, never the connection, and the next request
 * makes its own attempt. `StreamableHTTPClientTransport` closes only when this
 * connector closes it.
 *
 * If the endpoint ever serves SSE, a dropped-stream path becomes real and
 * belongs here — along with the notification relay `bridge.ts` records the same
 * dependency on.
 */
class HostedEndpoint implements RemoteEndpoint {
  public readonly label: string;

  private readonly logger: Logger;

  private readonly probe: EndpointProbe;

  private readonly client: Client;

  public constructor(label: string, client: Client, probe: EndpointProbe, logger: Logger) {
    this.label = label;
    this.client = client;
    this.probe = probe;
    this.logger = logger;
  }

  public get capabilities(): ServerCapabilities {
    return this.client.getServerCapabilities() ?? {};
  }

  public get serverInfo(): Implementation | undefined {
    return this.client.getServerVersion();
  }

  public get latestConnectorVersion(): string | undefined {
    return this.probe.latestConnectorVersion();
  }

  public get instructions(): string | undefined {
    return this.client.getInstructions();
  }

  public async forward<Schema extends AnySchema>(
    request: Request,
    resultSchema: Schema,
    options: RequestOptions,
  ): Promise<SchemaOutput<Schema>> {
    try {
      return await this.client.request(request, resultSchema, options);
    } catch (error: unknown) {
      throw this.explain(request.method, error, options);
    }
  }

  public async close(): Promise<void> {
    await this.client.close();
  }

  /** Decide what a failed forwarded request means, and what to throw for it. */
  private explain(method: string, error: unknown, options: RequestOptions): unknown {
    if (wasAborted(error, options)) {
      // The downstream client withdrew the request. Nothing failed, and
      // rewriting the abort as an endpoint fault would be a lie in a log.
      return error;
    }

    if (error instanceof McpError && error.code !== CONNECTION_CLOSED_CODE) {
      // The endpoint answered, and its answer belongs to the caller: a tool
      // outside this token's scope, an invalid argument, a refusal. Rewriting it
      // as a connector fault would hide the only useful information in it.
      return error;
    }

    const failure = classifyRemoteFailure(error, this.label, this.probe.retryAfterFor(RATE_LIMITED_STATUS));
    this.logger.warn({ method, kind: failure.kind, endpoint: this.label }, 'a forwarded request failed');

    return new McpError(ErrorCode.InternalError, failure.message);
  }
}

/**
 * Open one client against the endpoint. The token reaches exactly one header.
 *
 * No client capabilities are advertised. Sampling, elicitation and roots all
 * belong to the downstream client, which has not connected to this connector
 * yet — the endpoint's own capabilities are needed to answer its `initialize`,
 * so this handshake necessarily happens first. The hosted endpoint uses none of
 * the three; a release that starts to would need this handshake deferred, which
 * is a larger change than adding a flag here.
 */
async function openClient(options: ConnectRemoteOptions, probe: EndpointProbe): Promise<Client> {
  const client = new Client({ name: CONNECTOR_NAME, version: CONNECTOR_VERSION }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(options.endpoint, {
    fetch: probe.fetch,
    requestInit: { headers: { Authorization: `Bearer ${options.token}` } },
  });

  // `StreamableHTTPClientTransport` exposes `sessionId` as a getter typed
  // `string | undefined`, while `Transport` declares it as an optional
  // `string`. Under `exactOptionalPropertyTypes` those are different types — a
  // defect in the SDK's own declarations rather than something this code can
  // express its way out of, and the same one `apps/mcp/src/server.ts` records
  // for the server transport. The assertion is confined to this line and claims
  // nothing about the object that is not already true of it.
  await client.connect(transport as Transport);
  return client;
}

/**
 * Connect to the hosted endpoint, retrying only what retrying can fix.
 *
 * @param options - Endpoint, token, logger, and the injectable `fetch` and retry policy.
 * @returns The connected endpoint, ready to forward.
 * @throws {RemoteConnectionError} If the endpoint refused the token, or could not be reached within the retry budget.
 */
export async function connectRemote(options: ConnectRemoteOptions): Promise<RemoteEndpoint> {
  const label = describeEndpoint(options.endpoint);
  const policy = options.retry ?? DEFAULT_CONNECT_RETRY;
  const probe = createEndpointProbe(options.fetch, { logger: options.logger });

  let delayMs = policy.initialDelayMs;
  let lastFailure: RemoteFailure = {
    kind: 'unreachable',
    message: `${label} was not attempted: the retry budget is empty.`,
  };

  // `attempts` bounds the loop; a permanent refusal leaves it earlier still.
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      const client = await openClient(options, probe);
      options.logger.info({ endpoint: label, attempt }, 'connected to the hosted endpoint');
      return new HostedEndpoint(label, client, probe, options.logger);
    } catch (error: unknown) {
      lastFailure = classifyRemoteFailure(error, label, probe.retryAfterFor(RATE_LIMITED_STATUS));

      if (isPermanentFailure(lastFailure.kind)) {
        // A rejected token does not become accepted by asking again, and a
        // connector that keeps asking is indistinguishable from credential
        // stuffing to the endpoint's rate limiter.
        break;
      }

      if (attempt < policy.attempts) {
        options.logger.warn(
          { endpoint: label, attempt, reason: lastFailure.message, retryInMs: delayMs },
          'could not reach the hosted endpoint; retrying',
        );
        await delay(delayMs);
        delayMs = Math.min(Math.round(delayMs * policy.growthFactor), policy.maximumDelayMs);
      }
    }
  }

  throw new RemoteConnectionError(lastFailure);
}
