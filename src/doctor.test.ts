import { describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { REDACTED } from './diagnostics.js';
import { runDoctor, takeDoctorSubcommand } from './doctor.js';
import { LATEST_VERSION_HEADER } from './upgrade.js';
import { MINIMUM_NODE_MAJOR } from './node-version.js';
import { createHostedEndpoint, STUB_TOOL, TEST_ENDPOINT_URL, TEST_TOKEN } from './testing/endpoint.js';
import { CONNECTOR_NAME, CONNECTOR_VERSION } from './version.js';

/**
 * The report, and the one promise that outranks every other assertion here:
 * **the token never appears in it.**
 *
 * A diagnostic report is written to be pasted — into an issue, into a support
 * thread, into a chat window. Every case below therefore ends by searching the
 * whole text for the token, on the failure paths as much as the success one,
 * because the failure paths are the ones a merchant actually pastes.
 */

const SUPPORTED_NODE = `${String(MINIMUM_NODE_MAJOR)}.0.0`;
const UNSUPPORTED_NODE = `${String(MINIMUM_NODE_MAJOR - 2)}.19.0`;

describe('takeDoctorSubcommand', () => {
  it('recognises the subcommand and takes it off', () => {
    expect(takeDoctorSubcommand(['doctor'])).toEqual([]);
  });

  it('leaves an endpoint argument behind for resolveConfig', () => {
    // The whole reason it is removed rather than passed through: `config.ts`
    // reads the first positional as the endpoint URL.
    expect(takeDoctorSubcommand(['doctor', TEST_ENDPOINT_URL])).toEqual([TEST_ENDPOINT_URL]);
  });

  it('skips flags when looking for the subcommand, and keeps them', () => {
    expect(takeDoctorSubcommand(['--verbose', 'doctor', TEST_ENDPOINT_URL])).toEqual(['--verbose', TEST_ENDPOINT_URL]);
  });

  it('is undefined when no subcommand was asked for', () => {
    expect(takeDoctorSubcommand([])).toBeUndefined();
    expect(takeDoctorSubcommand([TEST_ENDPOINT_URL])).toBeUndefined();
    expect(takeDoctorSubcommand(['--verbose'])).toBeUndefined();
  });

  it('is undefined when `doctor` is not the first positional', () => {
    // An endpoint followed by a stray word is a mistyped argument list, not a
    // request for a report; treating it as one would run the wrong command.
    expect(takeDoctorSubcommand([TEST_ENDPOINT_URL, 'doctor'])).toBeUndefined();
  });
});

describe('runDoctor', () => {
  it('reports a healthy install and exits zero', async () => {
    const stub = createHostedEndpoint();
    const fetchWithLatestVersion: FetchLike = async (url, init) => {
      const response = await stub.fetch(url, init);
      const headers = new Headers(response.headers);
      headers.set(LATEST_VERSION_HEADER, '1.4.0');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    };

    const report = await runDoctor({
      argv: [TEST_ENDPOINT_URL],
      env: { M_MCP_TOKEN: TEST_TOKEN },
      nodeVersion: SUPPORTED_NODE,
      binaryPath: '/usr/local/bin/m-mcp-connector',
      fetch: fetchWithLatestVersion,
    });

    expect(report.exitCode).toBe(0);
    expect(report.fault).toBeUndefined();
    expect(report.text).toContain(`${CONNECTOR_NAME} ${CONNECTOR_VERSION}`);
    expect(report.text).toContain('endpoint advertises 1.4.0');
    expect(report.text).toContain('/usr/local/bin/m-mcp-connector');
    expect(report.text).toContain(STUB_TOOL);
    expect(report.text).not.toContain(TEST_TOKEN);
  });

  it('resolves the reported binary path through a symlink', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'm-mcp-doctor-'));
    const target = join(directory, 'dist', 'cli.js');
    const link = join(directory, 'm-mcp-connector');
    try {
      mkdirSync(join(directory, 'dist'));
      writeFileSync(target, '', { encoding: 'utf8', flag: 'wx' });
      symlinkSync(target, link);

      const report = await runDoctor({
        argv: [TEST_ENDPOINT_URL],
        env: { M_MCP_TOKEN: TEST_TOKEN },
        nodeVersion: SUPPORTED_NODE,
        binaryPath: link,
        fetch: createHostedEndpoint().fetch,
      });

      expect(report.text).toContain(`Binary:        ${realpathSync(target)}`);
      expect(report.text).not.toContain(`Binary:        ${link}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ends with a configuration block built around the absolute path', async () => {
    // This is the actual fix for the PATH failure the command exists for: a
    // merchant copies this block and their client stops depending on PATH.
    const stub = createHostedEndpoint();

    const report = await runDoctor({
      argv: [TEST_ENDPOINT_URL],
      env: { M_MCP_TOKEN: TEST_TOKEN },
      nodeVersion: SUPPORTED_NODE,
      binaryPath: '/opt/homebrew/bin/m-mcp-connector',
      fetch: stub.fetch,
    });

    const block = report.text.slice(report.text.indexOf('{'));
    const parsed = JSON.parse(block) as { mcpServers: { 'm-mcp': { command: string; env: Record<string, string> } } };

    expect(parsed.mcpServers['m-mcp'].command).toBe('/opt/homebrew/bin/m-mcp-connector');
    expect(parsed.mcpServers['m-mcp'].env['M_MCP_TOKEN']).not.toBe(TEST_TOKEN);
  });

  it('names the endpoint by origin and path, never with a query string', async () => {
    const stub = createHostedEndpoint();

    const report = await runDoctor({
      argv: [`${TEST_ENDPOINT_URL}?p=${TEST_TOKEN}`],
      env: {},
      nodeVersion: SUPPORTED_NODE,
      binaryPath: '/usr/local/bin/m-mcp-connector',
      fetch: stub.fetch,
    });

    expect(report.exitCode).toBe(0);
    expect(report.text).toContain(TEST_ENDPOINT_URL);
    expect(report.text).not.toContain('?p=');
    expect(report.text).not.toContain(TEST_TOKEN);
  });

  it('reports an unsupported Node without attempting the endpoint', async () => {
    const stub = createHostedEndpoint();

    const report = await runDoctor({
      argv: [TEST_ENDPOINT_URL],
      env: { M_MCP_TOKEN: TEST_TOKEN },
      nodeVersion: UNSUPPORTED_NODE,
      binaryPath: '/usr/local/bin/m-mcp-connector',
      fetch: stub.fetch,
    });

    expect(report.exitCode).toBe(1);
    expect(report.fault).toBe('configuration');
    expect(report.text).toContain(UNSUPPORTED_NODE);
    expect(stub.targets).toEqual([]);
    expect(report.text).not.toContain(TEST_TOKEN);
  });

  it('reports a missing token as a configuration fault', async () => {
    const report = await runDoctor({
      argv: [TEST_ENDPOINT_URL],
      env: {},
      nodeVersion: SUPPORTED_NODE,
      binaryPath: '/usr/local/bin/m-mcp-connector',
      fetch: createHostedEndpoint().fetch,
    });

    expect(report.exitCode).toBe(1);
    expect(report.fault).toBe('configuration');
    expect(report.text).toContain('M_MCP_TOKEN');
  });

  it('reports a refused token as a credential fault', async () => {
    const stub = createHostedEndpoint({ behaviour: { refuseWith: 401 } });

    const report = await runDoctor({
      argv: [TEST_ENDPOINT_URL],
      env: { M_MCP_TOKEN: TEST_TOKEN },
      nodeVersion: SUPPORTED_NODE,
      binaryPath: '/usr/local/bin/m-mcp-connector',
      fetch: stub.fetch,
    });

    expect(report.exitCode).toBe(1);
    expect(report.fault).toBe('credential');
    expect(report.text).not.toContain(TEST_TOKEN);
  });

  it('reports an unreachable endpoint as an endpoint fault, not the merchant’s', async () => {
    const stub = createHostedEndpoint({ behaviour: { unreachable: true } });

    const report = await runDoctor({
      argv: [TEST_ENDPOINT_URL],
      env: { M_MCP_TOKEN: TEST_TOKEN },
      nodeVersion: SUPPORTED_NODE,
      binaryPath: '/usr/local/bin/m-mcp-connector',
      fetch: stub.fetch,
    });

    expect(report.exitCode).toBe(1);
    expect(report.fault).toBe('endpoint');
    expect(report.text).toContain('nothing you configured is wrong');
    expect(report.text).not.toContain(TEST_TOKEN);
  });

  it('scrubs a token that arrived inside somebody else’s error message', async () => {
    // The case every other assertion here misses. The rest exercise paths that
    // never carry the token, so all of them would still pass with the redaction
    // removed. This one fails without it.
    //
    // A dependency that quotes the request it failed on is not hypothetical —
    // it is the ordinary shape of a transport error — and `describeError`
    // returns that message verbatim into a report the merchant is told to paste.
    const leaky: FetchLike = () => {
      throw new Error(`connect ECONNREFUSED while requesting https://hosted.example.test/mcp?p=${TEST_TOKEN}`);
    };

    const report = await runDoctor({
      argv: [TEST_ENDPOINT_URL],
      env: { M_MCP_TOKEN: TEST_TOKEN },
      nodeVersion: SUPPORTED_NODE,
      binaryPath: '/usr/local/bin/m-mcp-connector',
      fetch: leaky,
    });

    expect(report.exitCode).toBe(1);
    expect(report.text).not.toContain(TEST_TOKEN);
    expect(report.text).toContain(REDACTED);
  });

  it('scrubs a token supplied only in the URL, on a path where resolution failed', async () => {
    // Nothing resolves a token here — the endpoint is refused before the
    // configuration is ever used — so a scrub keyed on `config.token` would
    // have nothing to scrub with. This is why the candidates are read from the
    // inputs instead.
    const leaky: FetchLike = () => {
      throw new Error(`upstream rejected ?p=${TEST_TOKEN}`);
    };

    const report = await runDoctor({
      argv: [`${TEST_ENDPOINT_URL}?p=${TEST_TOKEN}`],
      env: {},
      nodeVersion: SUPPORTED_NODE,
      binaryPath: '/usr/local/bin/m-mcp-connector',
      fetch: leaky,
    });

    expect(report.text).not.toContain(TEST_TOKEN);
    expect(report.text).toContain(REDACTED);
  });

  it('says so when the binary path does not resolve on disk', async () => {
    const stub = createHostedEndpoint();

    const report = await runDoctor({
      argv: [TEST_ENDPOINT_URL],
      env: { M_MCP_TOKEN: TEST_TOKEN },
      nodeVersion: SUPPORTED_NODE,
      binaryPath: '/nowhere/at/all/m-mcp-connector',
      fetch: stub.fetch,
    });

    expect(report.text).toContain('does not resolve on disk');
  });
});
