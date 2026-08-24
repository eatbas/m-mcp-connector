import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ErrorCode,
  ListPromptsResultSchema,
  ListToolsResultSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import { classifyRemoteFailure, connectRemote, isPermanentFailure, RemoteConnectionError } from './remote.js';
import type { RemoteEndpoint, RetryPolicy } from './remote.js';
import {
  createCapturingSink,
  createHostedEndpoint,
  STUB_INSTRUCTIONS,
  STUB_SERVER_NAME,
  STUB_SERVER_VERSION,
  STUB_TOOL,
  TEST_ENDPOINT_URL,
  TEST_TOKEN,
} from './testing/endpoint.js';
import type { CapturedOutput, HostedEndpointStub } from './testing/endpoint.js';

/** Fast enough that the retry budget costs milliseconds rather than seconds. */
const FAST_RETRY: RetryPolicy = { attempts: 3, initialDelayMs: 1, growthFactor: 2, maximumDelayMs: 4 };

const opened: RemoteEndpoint[] = [];

interface Fixture {
  readonly output: CapturedOutput;
  readonly logger: Logger;
}

function fixture(): Fixture {
  const output = createCapturingSink();
  const logger = createLogger({ name: 'test', level: 'debug', secrets: [TEST_TOKEN], write: output.write });
  return { output, logger };
}

async function open(
  stub: HostedEndpointStub,
  logger: Logger,
  retry: RetryPolicy = FAST_RETRY,
): Promise<RemoteEndpoint> {
  const remote = await connectRemote({
    endpoint: new URL(TEST_ENDPOINT_URL),
    token: TEST_TOKEN,
    logger,
    fetch: stub.fetch,
    retry,
  });
  opened.push(remote);
  return remote;
}

afterEach(async () => {
  while (opened.length > 0) {
    await opened.pop()?.close();
  }
});

describe('connectRemote', () => {
  it('presents the token as a bearer header and never in the URL', async () => {
    const stub = createHostedEndpoint();
    const { logger } = fixture();

    const remote = await open(stub, logger);

    expect(stub.authorisations).toContain(`Bearer ${TEST_TOKEN}`);
    expect(remote.label).toBe('https://hosted.example.test/mcp');
    for (const target of stub.targets) {
      expect(target).not.toContain(TEST_TOKEN);
      expect(target).not.toContain('p=');
    }
  });

  it('reports the endpoint identity, capabilities and guidance it was given', async () => {
    const stub = createHostedEndpoint({ withPrompts: true });
    const { logger } = fixture();

    const remote = await open(stub, logger);

    expect(remote.serverInfo).toMatchObject({ name: STUB_SERVER_NAME, version: STUB_SERVER_VERSION });
    expect(remote.latestConnectorVersion).toBeUndefined();
    expect(remote.instructions).toBe(STUB_INSTRUCTIONS);
    expect(remote.capabilities.tools).toBeDefined();
    expect(remote.capabilities.prompts).toBeDefined();
  });

  it('writes nothing about the token, at the loudest verbosity there is', async () => {
    const stub = createHostedEndpoint();
    const { logger, output } = fixture();

    await open(stub, logger);

    expect(output.text()).not.toContain(TEST_TOKEN);
    expect(output.text()).not.toContain(TEST_TOKEN.slice(0, 16));
    expect(output.text()).not.toContain('Bearer');
  });

  it('retries an endpoint that was briefly unreachable', async () => {
    const stub = createHostedEndpoint();
    let attempts = 0;
    const flaky: FetchLike = async (url, init) => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      }
      return stub.fetch(url, init);
    };
    const { logger } = fixture();

    const remote = await connectRemote({
      endpoint: new URL(TEST_ENDPOINT_URL),
      token: TEST_TOKEN,
      logger,
      fetch: flaky,
      retry: FAST_RETRY,
    });
    opened.push(remote);

    expect(remote.capabilities.tools).toBeDefined();
    expect(attempts).toBeGreaterThan(1);
  });

  it('gives up after the retry budget and says what the network reported', async () => {
    const stub = createHostedEndpoint({ behaviour: { unreachable: true } });
    const { logger } = fixture();

    await expect(open(stub, logger)).rejects.toThrow(RemoteConnectionError);
    await expect(open(stub, logger)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('does not retry a refused token, because asking again cannot change the answer', async () => {
    const stub = createHostedEndpoint({ behaviour: { refuseWith: 401 } });
    const { logger } = fixture();

    await expect(open(stub, logger)).rejects.toMatchObject({ kind: 'unauthorised' });
    // One attempt only: a connector that keeps presenting a rejected credential
    // is indistinguishable from credential stuffing to a rate limiter.
    expect(stub.authorisations).toHaveLength(1);
  });

  it('treats a revoked token as permanent too', async () => {
    const stub = createHostedEndpoint({ behaviour: { refuseWith: 403 } });
    const { logger } = fixture();

    await expect(open(stub, logger)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(stub.authorisations).toHaveLength(1);
  });
});

describe('a forwarded request', () => {
  it('returns the endpoint answer unchanged', async () => {
    const stub = createHostedEndpoint();
    const { logger } = fixture();
    const remote = await open(stub, logger);

    const listed = await remote.forward({ method: 'tools/list' }, ListToolsResultSchema, {});

    expect(listed.tools.map((tool) => tool.name)).toEqual([STUB_TOOL]);
  });

  it('passes an error the endpoint itself returned straight through', async () => {
    // The endpoint answered, and its answer is the caller's business. Rewriting
    // it as a connector fault would hide the only useful information in it.
    const stub = createHostedEndpoint();
    const { logger } = fixture();
    const remote = await open(stub, logger);

    await expect(remote.forward({ method: 'prompts/list' }, ListPromptsResultSchema, {})).rejects.toBeInstanceOf(
      McpError,
    );
  });

  it('explains a transport refusal in a sentence, and names the wait a 429 asked for', async () => {
    const stub = createHostedEndpoint();
    const { logger } = fixture();
    const remote = await open(stub, logger);
    stub.behave({ refuseWith: 429, retryAfterSeconds: 30 });

    await expect(remote.forward({ method: 'tools/list' }, ListToolsResultSchema, {})).rejects.toThrow(
      /rate limiting this token\. Retry after 30 seconds/,
    );
  });

  it('sends a failed request exactly once', async () => {
    // A forwarded call that failed may already have been served, metered and
    // counted against the merchant's quota.
    const stub = createHostedEndpoint();
    const { logger } = fixture();
    const remote = await open(stub, logger);
    const before = stub.authorisations.length;
    stub.behave({ refuseWith: 500 });

    await expect(remote.forward({ method: 'tools/list' }, ListToolsResultSchema, {})).rejects.toThrow();

    expect(stub.authorisations).toHaveLength(before + 1);
  });

  it('rethrows a cancellation as a cancellation rather than an endpoint fault', async () => {
    const stub = createHostedEndpoint();
    const { logger } = fixture();
    const remote = await open(stub, logger);
    const controller = new AbortController();
    controller.abort(new Error('the client withdrew the request'));

    await expect(
      remote.forward({ method: 'tools/list' }, ListToolsResultSchema, { signal: controller.signal }),
    ).rejects.toThrow('the client withdrew the request');
  });

  it('says nothing about the token when a request fails', async () => {
    const stub = createHostedEndpoint();
    const { logger, output } = fixture();
    const remote = await open(stub, logger);
    stub.behave({ refuseWith: 401 });

    await expect(remote.forward({ method: 'tools/list' }, ListToolsResultSchema, {})).rejects.toThrow();

    expect(output.text()).not.toContain(TEST_TOKEN);
    expect(output.text()).not.toContain('Bearer');
  });
});

describe('closing', () => {
  it('refuses a request that arrives after the connection was released', async () => {
    // The shutdown race: the bridge is closed before the endpoint, but an
    // in-flight forward can still land here. It must fail as one readable
    // sentence rather than as an unhandled rejection.
    const stub = createHostedEndpoint();
    const { logger } = fixture();
    const remote = await open(stub, logger);

    await remote.close();
    opened.pop();

    await expect(remote.forward({ method: 'tools/list' }, ListToolsResultSchema, {})).rejects.toBeInstanceOf(McpError);
  });

  it('can be closed twice without complaint', async () => {
    const stub = createHostedEndpoint();
    const { logger } = fixture();
    const remote = await open(stub, logger);

    await remote.close();
    await expect(remote.close()).resolves.toBeUndefined();
    opened.pop();
  });
});

describe('classifyRemoteFailure', () => {
  const endpoint = 'https://hosted.example.test/mcp';

  it('names the endpoint without a query string, whatever the failure', () => {
    const failures = [
      classifyRemoteFailure(new Error('boom'), endpoint, undefined),
      classifyRemoteFailure(new McpError(ErrorCode.ConnectionClosed, 'gone'), endpoint, undefined),
      classifyRemoteFailure(new StreamableHTTPError(401, 'refused'), endpoint, undefined),
      classifyRemoteFailure(new StreamableHTTPError(503, 'refused'), endpoint, undefined),
    ];

    for (const failure of failures) {
      expect(failure.message).toContain(endpoint);
      expect(failure.message).not.toContain('?');
    }
  });

  it('separates the two credential refusals from everything else', () => {
    expect(classifyRemoteFailure(new StreamableHTTPError(401, 'x'), endpoint, undefined).kind).toBe('unauthorised');
    expect(classifyRemoteFailure(new StreamableHTTPError(403, 'x'), endpoint, undefined).kind).toBe('forbidden');
    expect(classifyRemoteFailure(new StreamableHTTPError(503, 'x'), endpoint, undefined).kind).toBe('protocol');
  });

  it('says "shortly" when a 429 carried no Retry-After, rather than inventing a number', () => {
    const failure = classifyRemoteFailure(new StreamableHTTPError(429, 'x'), endpoint, undefined);

    expect(failure.kind).toBe('rateLimited');
    expect(failure.message).toContain('Retry shortly.');
  });

  it('names the wait the endpoint asked for when it sent one', () => {
    expect(classifyRemoteFailure(new StreamableHTTPError(429, 'x'), endpoint, 30).message).toContain(
      'Retry after 30 seconds.',
    );
  });

  it('tells an unusable answer apart from a closed connection', () => {
    expect(classifyRemoteFailure(new McpError(ErrorCode.ParseError, 'bad'), endpoint, undefined).kind).toBe('protocol');
    expect(classifyRemoteFailure(new McpError(ErrorCode.ConnectionClosed, 'gone'), endpoint, undefined).kind).toBe(
      'unreachable',
    );
  });

  it('marks exactly the two refusals a merchant has to act on as permanent', () => {
    expect(isPermanentFailure('unauthorised')).toBe(true);
    expect(isPermanentFailure('forbidden')).toBe(true);
    expect(isPermanentFailure('rateLimited')).toBe(false);
    expect(isPermanentFailure('unreachable')).toBe(false);
    expect(isPermanentFailure('protocol')).toBe(false);
  });
});
