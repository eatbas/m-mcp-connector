import { describe, expect, it } from 'vitest';

import {
  createCapturingSink,
  createForbiddenFetch,
  createHostedEndpoint,
  STUB_TOOL,
  TEST_ENDPOINT_URL,
  waitFor,
} from './endpoint.js';

/**
 * The stub, tested.
 *
 * Everything else in this suite trusts it: a stub that quietly served a request
 * it was told to refuse, or that dropped the `Authorization` header it is meant
 * to record, would turn several tests green for the wrong reason.
 */

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } },
};

async function post(stub: ReturnType<typeof createHostedEndpoint>, body: unknown): Promise<Response> {
  return stub.fetch(TEST_ENDPOINT_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer probe-token-value',
    },
    body: JSON.stringify(body),
  });
}

describe('the hosted endpoint stub', () => {
  it('answers a POST with a single JSON body, as the deployed endpoint does', async () => {
    const stub = createHostedEndpoint();

    const response = await post(stub, INITIALIZE);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: 1 });
  });

  it('records every authorisation header and every target it was sent', async () => {
    const stub = createHostedEndpoint();

    await post(stub, INITIALIZE);

    expect(stub.authorisations).toEqual(['Bearer probe-token-value']);
    expect(stub.targets).toEqual([TEST_ENDPOINT_URL]);
  });

  it('answers a GET with 405, which is how the deployed endpoint declines an SSE stream', async () => {
    const stub = createHostedEndpoint();

    const response = await stub.fetch(TEST_ENDPOINT_URL, { method: 'GET' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('refuses with the configured status and carries the Retry-After it was given', async () => {
    const stub = createHostedEndpoint({ behaviour: { refuseWith: 429, retryAfterSeconds: 30 } });

    const response = await post(stub, INITIALIZE);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
  });

  it('fails the way a closed port does when told to be unreachable', async () => {
    const stub = createHostedEndpoint({ behaviour: { unreachable: true } });

    await expect(post(stub, INITIALIZE)).rejects.toThrow('fetch failed');
  });

  it('changes behaviour between requests', async () => {
    const stub = createHostedEndpoint();
    expect((await post(stub, INITIALIZE)).status).toBe(200);

    stub.behave({ refuseWith: 503 });

    expect((await post(stub, INITIALIZE)).status).toBe(503);
  });

  it('serves resources and prompts only when asked to', async () => {
    const bare = await post(createHostedEndpoint(), INITIALIZE);
    const full = await post(createHostedEndpoint({ withResources: true, withPrompts: true }), INITIALIZE);

    const bareCapabilities = ((await bare.json()) as { result: { capabilities: Record<string, unknown> } }).result
      .capabilities;
    const fullCapabilities = ((await full.json()) as { result: { capabilities: Record<string, unknown> } }).result
      .capabilities;

    expect(bareCapabilities['resources']).toBeUndefined();
    expect(bareCapabilities['tools']).toBeDefined();
    expect(fullCapabilities['resources']).toBeDefined();
    expect(fullCapabilities['prompts']).toBeDefined();
  });

  it('names its one tool as the real manifest names its tools', () => {
    expect(STUB_TOOL).toBe('search_docs');
  });
});

describe('the test helpers', () => {
  it('captures written lines as text and as parsed records', () => {
    const sink = createCapturingSink();

    sink.write('{"level":"info","msg":"first"}\n');
    sink.write('{"level":"warn","msg":"second"}\n');

    expect(sink.text()).toContain('first');
    expect(sink.records()).toEqual([
      { level: 'info', msg: 'first' },
      { level: 'warn', msg: 'second' },
    ]);
  });

  it('records and refuses anything that reaches the forbidden fetch', async () => {
    const touched: string[] = [];

    await expect(
      createForbiddenFetch((target) => touched.push(target))('https://nowhere.example.test/'),
    ).rejects.toThrow('the network must not be touched');

    expect(touched).toEqual(['https://nowhere.example.test/']);
  });

  it('gives up rather than hanging when a condition never holds', async () => {
    await expect(waitFor(() => false, 20)).rejects.toThrow(/still false after 20ms/);
  });

  it('returns as soon as the condition holds', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 5);

    await expect(waitFor(() => ready, 500)).resolves.toBeUndefined();
  });
});
