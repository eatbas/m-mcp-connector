import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  CompleteRequestSchema,
  CompleteResultSchema,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

import type { RemoteEndpoint } from './remote.js';
import { CONNECTOR_NAME, CONNECTOR_VERSION } from './version.js';

/**
 * The stdio surface an MCP client sees, in front of the hosted endpoint.
 *
 * Built on the low-level `Server` rather than `McpServer`. The SDK marks that
 * class deprecated in favour of the high-level API, and the deprecation is
 * addressed at servers that own their tools: `McpServer` exists to register
 * concrete tools, resources and prompts, and this bridge has none — it has a
 * request to forward and no idea what the endpoint will offer until it asks.
 * Registering the endpoint's tool list locally would put a second, stale copy of
 * the tool surface on the merchant's machine, which is exactly what a bridge
 * must not do.
 *
 * ── What is forwarded, and what is not ───────────────────────────────────────
 *
 *  - **Every request in a capability the endpoint advertises** is forwarded
 *    verbatim, including the caller's abort signal, and its answer is returned
 *    unchanged. The endpoint decides what this token may call; this connector
 *    holds no policy of its own and must not appear to.
 *  - **`initialize`** is answered here, from what the endpoint reported when
 *    this process connected. It cannot be forwarded: MCP fixes a session's
 *    capabilities at initialisation, and this connector's session with the
 *    endpoint was established before the client's session with it.
 *  - **`ping`** is answered by the SDK's own handler. It is a liveness probe of
 *    *this* process, and turning it into a network round trip would make a
 *    healthy connector look dead whenever the endpoint was slow.
 *  - **Notifications in either direction are not relayed**, and neither are
 *    resource subscriptions, `logging/setLevel` or any `listChanged` flag. The
 *    hosted endpoint runs its Streamable HTTP transport with
 *    `enableJsonResponse: true` and no session (see `STATELESS_TRANSPORT_OPTIONS`
 *    in `apps/mcp/src/server.ts`), so each request is one POST answered by one
 *    JSON body: there is no stream on which a server-initiated message could
 *    arrive, and nothing to relay. {@link advertisedCapabilities} therefore
 *    drops those flags rather than advertising a feature that would silently do
 *    nothing. If the endpoint ever serves SSE, the relay and the flags belong
 *    back here in the same change.
 */

export interface BridgeOptions {
  readonly remote: RemoteEndpoint;
}

/**
 * What the connector tells the client it can do.
 *
 * The endpoint's own capabilities, minus every one that depends on a
 * server-initiated message. Under-advertising costs a feature the endpoint does
 * not currently offer; over-advertising costs a client that waits for
 * notifications which cannot arrive, or subscribes to a resource nothing will
 * ever update.
 *
 * @param remote - Capabilities the hosted endpoint reported at `initialize`.
 * @returns The capabilities this bridge can actually honour.
 */
export function advertisedCapabilities(remote: ServerCapabilities): ServerCapabilities {
  return {
    ...(remote.tools === undefined ? {} : { tools: {} }),
    // Deliberately no `subscribe`: a subscription exists to produce
    // `notifications/resources/updated`, which cannot reach this process.
    ...(remote.resources === undefined ? {} : { resources: {} }),
    ...(remote.prompts === undefined ? {} : { prompts: {} }),
    // Completions are a plain request and response, so they survive the
    // restriction above intact.
    ...(remote.completions === undefined ? {} : { completions: {} }),
  };
}

/**
 * Per-request options for one forwarded call.
 *
 * The abort signal is the whole of it. When the downstream client cancels, the
 * SDK aborts `extra.signal`, which aborts the in-flight `fetch` to the endpoint
 * rather than leaving it running and unread. No progress callback is installed,
 * for the reason given at the top of this file: the endpoint answers with a
 * single JSON body and never sends progress.
 */
function forwardOptions(extra: { readonly signal: AbortSignal }): RequestOptions {
  return { signal: extra.signal };
}

/** `tools/list` and `tools/call`, registered only when the endpoint serves tools. */
function registerToolHandlers(server: Server, remote: RemoteEndpoint): void {
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) =>
    remote.forward(request, ListToolsResultSchema, forwardOptions(extra)),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    remote.forward(request, CallToolResultSchema, forwardOptions(extra)),
  );
}

/** The three resource reads. Registered only when the endpoint serves resources. */
function registerResourceHandlers(server: Server, remote: RemoteEndpoint): void {
  server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) =>
    remote.forward(request, ListResourcesResultSchema, forwardOptions(extra)),
  );

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) =>
    remote.forward(request, ListResourceTemplatesResultSchema, forwardOptions(extra)),
  );

  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) =>
    remote.forward(request, ReadResourceResultSchema, forwardOptions(extra)),
  );
}

/** `prompts/list` and `prompts/get`. Registered only when the endpoint serves prompts. */
function registerPromptHandlers(server: Server, remote: RemoteEndpoint): void {
  server.setRequestHandler(ListPromptsRequestSchema, async (request, extra) =>
    remote.forward(request, ListPromptsResultSchema, forwardOptions(extra)),
  );

  server.setRequestHandler(GetPromptRequestSchema, async (request, extra) =>
    remote.forward(request, GetPromptResultSchema, forwardOptions(extra)),
  );
}

/** `completion/complete`. Registered only when the endpoint offers completions. */
function registerCompletionHandlers(server: Server, remote: RemoteEndpoint): void {
  server.setRequestHandler(CompleteRequestSchema, async (request, extra) =>
    remote.forward(request, CompleteResultSchema, forwardOptions(extra)),
  );
}

/**
 * The identity the client is shown.
 *
 * The endpoint's own, when it reported one. A bridge that substituted its own
 * name would leave a merchant looking at "connector" in their client and
 * unable to tell which service it was in front of; the connector's build is
 * reported on stderr at start-up instead, which is where it is actually needed.
 */
function identityOf(remote: RemoteEndpoint): Implementation {
  return remote.serverInfo ?? { name: CONNECTOR_NAME, version: CONNECTOR_VERSION };
}

/**
 * Build the stdio server that fronts the hosted endpoint.
 *
 * @param options - The connected endpoint every request is forwarded to.
 * @returns A server ready to be connected to a transport. Nothing is registered that it cannot answer.
 */
export function createBridge(options: BridgeOptions): Server {
  const { remote } = options;
  const capabilities = advertisedCapabilities(remote.capabilities);
  const { instructions } = remote;

  const server = new Server(identityOf(remote), {
    capabilities,
    // Conditional rather than `instructions: remote.instructions`, because
    // `exactOptionalPropertyTypes` makes an explicit `undefined` a different
    // thing from an absent key — and the SDK would advertise the key.
    ...(instructions === undefined ? {} : { instructions }),
  });

  // Each group is registered only when the advertised capabilities claim it, so
  // the bridge never offers a method it would have to answer with an error, and
  // never registers one the SDK would refuse to accept a handler for.
  if (capabilities.tools !== undefined) {
    registerToolHandlers(server, remote);
  }

  if (capabilities.resources !== undefined) {
    registerResourceHandlers(server, remote);
  }

  if (capabilities.prompts !== undefined) {
    registerPromptHandlers(server, remote);
  }

  if (capabilities.completions !== undefined) {
    registerCompletionHandlers(server, remote);
  }

  return server;
}
