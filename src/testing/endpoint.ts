import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

/**
 * A stand-in for the hosted endpoint, answered inside the test process.
 *
 * A real `McpServer` behind the SDK's own Streamable HTTP server transport,
 * reached through an injected `fetch` rather than a socket. That keeps the
 * suite in one process while still exercising the parts that actually go wrong:
 * the `Authorization` header, the HTTP statuses the connector has to explain,
 * and the JSON-RPC framing on both sides.
 *
 * The transport is configured exactly as `apps/mcp/src/server.ts` configures
 * the real one — `enableJsonResponse: true`, no `sessionIdGenerator`, one
 * server per request — so a test cannot pass on state the deployed endpoint
 * would not have, and cannot rely on a stream the deployed endpoint never
 * opens.
 *
 * This module is excluded from `tsconfig.build.json`: it is test scaffolding
 * and has no business in a published package.
 */

/**
 * Shape-valid and entirely fabricated.
 *
 * Nothing here has ever been issued. It matches the `TOKEN_SHAPE` in both
 * `config.ts` and `apps/mcp/src/auth/token.ts` because the assertions are about
 * transport and redaction, and a real token in a test file would be a
 * credential in version control.
 */
export const TEST_TOKEN = `mcp_test_${'a1b2c3d4'.repeat(4)}`;

/** Endpoint the stub answers for. `.test` is reserved by RFC 2606 and resolves nowhere. */
export const TEST_ENDPOINT_URL = 'https://hosted.example.test/mcp';

/** A tool the stub serves, named as the real manifest names its tools. */
export const STUB_TOOL = 'search_docs';

/** Identity the stub reports at `initialize`, so a test can prove it was forwarded. */
export const STUB_SERVER_NAME = 'm-mcp';

export const STUB_SERVER_VERSION = '9.9.9-stub';

export const STUB_INSTRUCTIONS = 'Hosted guidance, forwarded verbatim.';

export const STUB_RESOURCE_URI = 'm-mcp://docs/jazzcash/mwallet-rest-v1-1';
export const STUB_RESOURCE_URI_TEMPLATE = 'm-mcp://docs/{system}/{topic}';
export const STUB_RESOURCE_TEXT = 'hosted indexed documentation';

/** How the stub should answer the next request. */
export interface EndpointBehaviour {
  /** Refuse with this status instead of serving. */
  readonly refuseWith?: number | undefined;
  /** `Retry-After`, in seconds, sent with a refusal. */
  readonly retryAfterSeconds?: number | undefined;
  /** Fail the way a closed port does, before any HTTP response exists. */
  readonly unreachable?: boolean | undefined;
}

export interface HostedEndpointStub {
  readonly fetch: FetchLike;
  /** Every `Authorization` header value the stub has been sent. */
  readonly authorisations: readonly string[];
  /** Every request target the stub has been sent, verbatim. */
  readonly targets: readonly string[];
  /** Tool names the stub was asked to call. */
  readonly calledTools: readonly string[];
  /** Resource URIs the stub was asked to read. */
  readonly readResources: readonly string[];
  behave(behaviour: EndpointBehaviour): void;
}

export interface HostedEndpointOptions {
  readonly withResources?: boolean | undefined;
  readonly withPrompts?: boolean | undefined;
  readonly behaviour?: EndpointBehaviour | undefined;
}

function buildStubServer(options: HostedEndpointOptions, calledTools: string[], readResources: string[]): McpServer {
  const server = new McpServer(
    { name: STUB_SERVER_NAME, version: STUB_SERVER_VERSION },
    { instructions: STUB_INSTRUCTIONS },
  );

  server.registerTool(
    STUB_TOOL,
    { description: 'Search the hosted corpus.', inputSchema: { query: z.string() } },
    (args: { query: string }) => {
      calledTools.push(STUB_TOOL);
      return { content: [{ type: 'text' as const, text: `hosted:${args.query}` }] };
    },
  );

  if (options.withResources === true) {
    server.registerResource(
      'indexed-documentation',
      new ResourceTemplate(STUB_RESOURCE_URI_TEMPLATE, {
        list: () => ({
          resources: [
            {
              uri: STUB_RESOURCE_URI,
              name: 'jazzcash/mwallet-rest-v1-1',
              title: 'MWallet REST v1.1',
              mimeType: 'text/markdown',
            },
          ],
        }),
      }),
      { description: 'Indexed corpus document.', mimeType: 'text/markdown' },
      (uri: URL) => {
        readResources.push(uri.href);
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: STUB_RESOURCE_TEXT }] };
      },
    );
  }

  if (options.withPrompts === true) {
    server.registerPrompt('integration_walkthrough', { description: 'Guided walkthrough.' }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'walkthrough' } }],
    }));
  }

  return server;
}

/**
 * Build the stub.
 *
 * @param options - Which surfaces the stub serves, and how it should misbehave.
 * @returns The `fetch` to inject, and the recordings a test asserts against.
 */
export function createHostedEndpoint(options: HostedEndpointOptions = {}): HostedEndpointStub {
  const authorisations: string[] = [];
  const targets: string[] = [];
  const calledTools: string[] = [];
  const readResources: string[] = [];
  let behaviour: EndpointBehaviour = options.behaviour ?? {};

  const fetchImpl: FetchLike = async (url, init) => {
    targets.push(String(url));
    const authorisation = new Headers(init?.headers).get('authorization');
    if (authorisation !== null) {
      authorisations.push(authorisation);
    }

    if (behaviour.unreachable === true) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3200'), { code: 'ECONNREFUSED' }),
      });
    }

    const { refuseWith } = behaviour;
    if (refuseWith !== undefined) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'refused' }, id: null }), {
        status: refuseWith,
        headers: {
          'Content-Type': 'application/json',
          ...(behaviour.retryAfterSeconds === undefined ? {} : { 'Retry-After': String(behaviour.retryAfterSeconds) }),
        },
      });
    }

    if ((init?.method ?? 'GET') !== 'POST') {
      // The deployed endpoint is stateless and serves POST only: there is no
      // stream to open and no session to delete. 405 is what it answers, and
      // what the SDK's client transport treats as "no SSE here, carry on".
      return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    }

    const server = buildStubServer(options, calledTools, readResources);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });

    await server.connect(transport);
    try {
      return await transport.handleRequest(new Request(url, init));
    } finally {
      await transport.close();
      await server.close();
    }
  };

  return {
    fetch: fetchImpl,
    authorisations,
    targets,
    calledTools,
    readResources,
    behave: (next): void => {
      behaviour = next;
    },
  };
}

export interface CapturedOutput {
  /** Pass as the logger's `write`. */
  readonly write: (line: string) => void;
  /** Every line written so far, joined. */
  readonly text: () => string;
  /** Every line written so far, parsed. */
  readonly records: () => readonly Record<string, unknown>[];
}

/** Capture what the connector logs, instead of letting it reach a file descriptor. */
export function createCapturingSink(): CapturedOutput {
  const lines: string[] = [];

  return {
    write: (line: string): void => {
      lines.push(line);
    },
    text: (): string => lines.join(''),
    records: (): readonly Record<string, unknown>[] =>
      lines
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** A `fetch` that fails the test if anything reaches it. */
export function createForbiddenFetch(record: (target: string) => void): FetchLike {
  return (url): Promise<Response> => {
    record(String(url));
    return Promise.reject(new Error('the network must not be touched'));
  };
}

/**
 * Poll until `condition` holds.
 *
 * Some of what this suite waits for is driven by a timer or a stream rather
 * than by a promise the caller can await. The timeout is what turns a
 * regression into a failing test rather than a suite that hangs.
 *
 * @param condition - Checked immediately and then every few milliseconds.
 * @param timeoutMs - How long to wait before giving up.
 */
export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition was still false after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
