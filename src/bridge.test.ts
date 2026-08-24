import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, describe, expect, it } from 'vitest';

import { advertisedCapabilities, createBridge } from './bridge.js';
import { createLogger } from './logger.js';
import { connectRemote } from './remote.js';
import type { RemoteEndpoint, RetryPolicy } from './remote.js';
import {
  createCapturingSink,
  createHostedEndpoint,
  STUB_INSTRUCTIONS,
  STUB_RESOURCE_TEXT,
  STUB_RESOURCE_URI,
  STUB_RESOURCE_URI_TEMPLATE,
  STUB_SERVER_NAME,
  STUB_SERVER_VERSION,
  STUB_TOOL,
  TEST_ENDPOINT_URL,
  TEST_TOKEN,
} from './testing/endpoint.js';
import type { CapturedOutput, HostedEndpointOptions, HostedEndpointStub } from './testing/endpoint.js';

const FAST_RETRY: RetryPolicy = { attempts: 1, initialDelayMs: 1, growthFactor: 2, maximumDelayMs: 4 };

interface Harness {
  /** The downstream client, standing in for the MCP client that spawned the connector. */
  readonly client: Client;
  readonly stub: HostedEndpointStub;
  readonly remote: RemoteEndpoint;
  readonly server: Server;
  readonly output: CapturedOutput;
  close(): Promise<void>;
}

const running: Harness[] = [];

async function startHarness(options: HostedEndpointOptions = {}): Promise<Harness> {
  const stub = createHostedEndpoint(options);
  const output = createCapturingSink();
  const logger = createLogger({ name: 'test', level: 'debug', secrets: [TEST_TOKEN], write: output.write });

  const remote = await connectRemote({
    endpoint: new URL(TEST_ENDPOINT_URL),
    token: TEST_TOKEN,
    logger,
    fetch: stub.fetch,
    retry: FAST_RETRY,
  });
  const server = createBridge({ remote });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'harness', version: '0.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const harness: Harness = {
    client,
    stub,
    remote,
    server,
    output,
    close: async (): Promise<void> => {
      await client.close();
      await server.close();
      await remote.close();
    },
  };
  running.push(harness);
  return harness;
}

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
});

describe('advertisedCapabilities', () => {
  it('passes through the four capabilities the bridge can honour', () => {
    const advertised = advertisedCapabilities({ tools: {}, resources: {}, prompts: {}, completions: {} });

    expect(advertised).toEqual({ tools: {}, resources: {}, prompts: {}, completions: {} });
  });

  it('advertises nothing the endpoint did not', () => {
    expect(advertisedCapabilities({})).toEqual({});
    expect(advertisedCapabilities({ tools: {} })).toEqual({ tools: {} });
  });

  it('drops every flag that would promise a message this bridge cannot deliver', () => {
    // The hosted endpoint answers each POST with one JSON body and opens no
    // stream, so nothing server-initiated can reach this process: a client that
    // subscribed, or waited for a list-changed notification, would wait forever.
    const advertised = advertisedCapabilities({
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      logging: {},
      experimental: { somethingElse: {} },
    });

    expect(advertised).toEqual({ tools: {}, resources: {}, prompts: {} });
  });
});

describe('the bridge', () => {
  it('reports the endpoint identity and guidance, not its own', () => {
    // A merchant looking at their client should see the service they are
    // actually talking to; the connector's build is on stderr, where it helps.
    return startHarness().then((harness) => {
      expect(harness.client.getServerVersion()).toMatchObject({
        name: STUB_SERVER_NAME,
        version: STUB_SERVER_VERSION,
      });
      expect(harness.client.getInstructions()).toBe(STUB_INSTRUCTIONS);
    });
  });

  it('forwards tools/list to the endpoint', async () => {
    const harness = await startHarness();

    const listed = await harness.client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual([STUB_TOOL]);
  });

  it('forwards tools/call and returns the endpoint answer unchanged', async () => {
    const harness = await startHarness();

    const result = await harness.client.callTool({ name: STUB_TOOL, arguments: { query: 'ipn' } });

    expect(JSON.stringify(result)).toContain('hosted:ipn');
    expect(harness.stub.calledTools).toEqual([STUB_TOOL]);
  });

  it('forwards resource lists, templates and reads unchanged when the endpoint serves them', async () => {
    const harness = await startHarness({ withResources: true, withPrompts: true });

    const [resources, templates, read, prompts] = await Promise.all([
      harness.client.listResources(),
      harness.client.listResourceTemplates(),
      harness.client.readResource({ uri: STUB_RESOURCE_URI }),
      harness.client.listPrompts(),
    ]);

    expect(resources.resources).toEqual([
      expect.objectContaining({ uri: STUB_RESOURCE_URI, mimeType: 'text/markdown' }),
    ]);
    expect(templates.resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: STUB_RESOURCE_URI_TEMPLATE, mimeType: 'text/markdown' }),
    ]);
    expect(read.contents).toEqual([{ uri: STUB_RESOURCE_URI, mimeType: 'text/markdown', text: STUB_RESOURCE_TEXT }]);
    expect(harness.stub.readResources).toEqual([STUB_RESOURCE_URI]);
    expect(prompts.prompts).toHaveLength(1);
  });

  it('registers no resource method when the endpoint has no resource capability', async () => {
    const harness = await startHarness();

    await expect(harness.client.listResources()).rejects.toThrow(/Method not found/i);
    await expect(harness.client.listResourceTemplates()).rejects.toThrow(/Method not found/i);
    await expect(harness.client.readResource({ uri: STUB_RESOURCE_URI })).rejects.toThrow(/Method not found/i);
    expect(harness.stub.readResources).toEqual([]);
  });

  it('refuses a method the endpoint does not serve rather than proxying it into an error', async () => {
    const harness = await startHarness();

    await expect(harness.client.listPrompts()).rejects.toThrow(/Method not found/i);
  });

  it('answers ping itself, so a slow endpoint cannot make a healthy connector look dead', async () => {
    const harness = await startHarness();
    const before = harness.stub.targets.length;
    harness.stub.behave({ unreachable: true });

    await expect(harness.client.ping()).resolves.toBeDefined();

    expect(harness.stub.targets).toHaveLength(before);
  });

  it('reports a transport failure to the caller as one readable sentence', async () => {
    const harness = await startHarness();
    harness.stub.behave({ refuseWith: 429, retryAfterSeconds: 12 });

    await expect(harness.client.listTools()).rejects.toThrow(/Retry after 12 seconds/);
  });

  it('says nothing about the token across a whole request cycle', async () => {
    const harness = await startHarness({ withResources: true });

    await harness.client.listTools();
    await harness.client.callTool({ name: STUB_TOOL, arguments: { query: 'ipn' } });
    await harness.client.listResources();
    await harness.client.listResourceTemplates();
    await harness.client.readResource({ uri: STUB_RESOURCE_URI });

    expect(harness.output.text()).not.toContain(TEST_TOKEN);
    expect(harness.output.text()).not.toContain('Bearer');
  });
});
