import { describe, expect, it } from 'vitest';

import { ConnectorConfigError, DEFAULT_ENDPOINT_URL, resolveConfig, TOKEN_ENV_VAR, URL_ENV_VAR } from './config.js';
import { TOKEN_QUERY_PARAMETER } from './diagnostics.js';
import { LOG_LEVEL_ENV_VAR } from './logger.js';

/**
 * Shape-valid and entirely fabricated. Nothing here has ever been issued: the
 * assertions are about the parser, and a real token in a test file would be a
 * credential in version control.
 */
const TOKEN = `m_mcp_${'a1b2c3d4'.repeat(4)}`;
const OTHER_TOKEN = `m_mcp_${'z9y8x7w6'.repeat(4)}`;

const ENDPOINT = 'https://hosted.example.test/mcp';

describe('resolveConfig', () => {
  it('takes the endpoint from the first argument and the token from its query parameter', () => {
    const config = resolveConfig([`${ENDPOINT}?${TOKEN_QUERY_PARAMETER}=${TOKEN}`], {});

    expect(config.token).toBe(TOKEN);
    expect(config.tokenSource).toBe('url');
    expect(config.warnings).toEqual([]);
  });

  it('strips the token out of the endpoint, so the transport can never send it in a URL', () => {
    // The whole point of taking it out here: `?p=` lands in the service's access
    // log and the reverse proxy's, and the header does not.
    const config = resolveConfig([`${ENDPOINT}?${TOKEN_QUERY_PARAMETER}=${TOKEN}&trace=1`], {});

    expect(config.endpoint.searchParams.has(TOKEN_QUERY_PARAMETER)).toBe(false);
    expect(config.endpoint.href).toBe(`${ENDPOINT}?trace=1`);
    expect(config.endpoint.href).not.toContain(TOKEN);
  });

  it('strips a token parameter that was supplied more than once', () => {
    const repeated = `${ENDPOINT}?${TOKEN_QUERY_PARAMETER}=${TOKEN}&${TOKEN_QUERY_PARAMETER}=${TOKEN}`;

    expect(resolveConfig([repeated], {}).endpoint.href).toBe(`${ENDPOINT}`);
  });

  it('falls back to the documented endpoint when only a token is configured', () => {
    const config = resolveConfig([], { [TOKEN_ENV_VAR]: TOKEN });

    expect(config.endpoint.href).toBe(DEFAULT_ENDPOINT_URL);
    expect(config.tokenSource).toBe('environment');
  });

  it('reads the endpoint from the environment when no argument was given', () => {
    const config = resolveConfig([], { [URL_ENV_VAR]: ENDPOINT, [TOKEN_ENV_VAR]: TOKEN });

    expect(config.endpoint.href).toBe(ENDPOINT);
  });

  it('lets the argument override the environment endpoint', () => {
    const config = resolveConfig([ENDPOINT], {
      [URL_ENV_VAR]: 'https://elsewhere.example.test/mcp',
      [TOKEN_ENV_VAR]: TOKEN,
    });

    expect(config.endpoint.href).toBe(ENDPOINT);
  });

  it('prefers the environment token over the one in the URL, because arguments are world readable', () => {
    // `ps` and /proc/<pid>/cmdline expose every argument this process was
    // started with; an MCP client's `env` block is not exposed that way.
    const config = resolveConfig([`${ENDPOINT}?${TOKEN_QUERY_PARAMETER}=${OTHER_TOKEN}`], { [TOKEN_ENV_VAR]: TOKEN });

    expect(config.token).toBe(TOKEN);
    expect(config.tokenSource).toBe('environment');
  });

  it('warns when the two tokens disagree, and names neither of them', () => {
    const config = resolveConfig([`${ENDPOINT}?${TOKEN_QUERY_PARAMETER}=${OTHER_TOKEN}`], { [TOKEN_ENV_VAR]: TOKEN });

    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain(TOKEN_ENV_VAR);
    expect(config.warnings.join(' ')).not.toContain(TOKEN);
    expect(config.warnings.join(' ')).not.toContain(OTHER_TOKEN);
  });

  it('says nothing when the same token was supplied twice', () => {
    const config = resolveConfig([`${ENDPOINT}?${TOKEN_QUERY_PARAMETER}=${TOKEN}`], { [TOKEN_ENV_VAR]: TOKEN });

    expect(config.warnings).toEqual([]);
  });

  it('ignores flags it does not recognise rather than refusing to start', () => {
    // The argument list is only partly the merchant's: an MCP client may add its
    // own, and an unknown one must not be able to stop the connector.
    const config = resolveConfig(['--verbose', '-q', ENDPOINT], { [TOKEN_ENV_VAR]: TOKEN });

    expect(config.endpoint.href).toBe(ENDPOINT);
  });

  it('uses the first URL argument and warns about the rest', () => {
    const config = resolveConfig([ENDPOINT, 'https://second.example.test/mcp'], { [TOKEN_ENV_VAR]: TOKEN });

    expect(config.endpoint.href).toBe(ENDPOINT);
    expect(config.warnings.join(' ')).toContain('further argument');
  });

  it('trims a token pasted with surrounding whitespace', () => {
    expect(resolveConfig([], { [TOKEN_ENV_VAR]: `  ${TOKEN}\n` }).token).toBe(TOKEN);
  });

  it('treats a blank token as absent, so the message names the real problem', () => {
    // MCP client configurations routinely carry `"M_MCP_TOKEN": ""` placeholders.
    for (const blank of ['', '   ']) {
      expect(() => resolveConfig([], { [TOKEN_ENV_VAR]: blank })).toThrow(/No access token/);
    }
  });

  it('refuses to start with no token at all, and says which variable to set', () => {
    const resolve = (): unknown => resolveConfig([], {});

    expect(resolve).toThrow(ConnectorConfigError);
    expect(resolve).toThrow(new RegExp(TOKEN_ENV_VAR));
  });

  it('refuses a malformed token without a network call and without echoing it', () => {
    const truncated = TOKEN.slice(0, 8);

    try {
      resolveConfig([], { [TOKEN_ENV_VAR]: truncated });
      expect.unreachable('a malformed token must be refused');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConnectorConfigError);
      // Not even a fragment: a prefix of a secret still narrows a search.
      expect((error as Error).message).not.toContain(truncated);
      expect((error as Error).message).toContain(TOKEN_ENV_VAR);
    }
  });

  it('refuses a token carrying characters the endpoint would reject', () => {
    for (const malformed of [`${TOKEN} ${TOKEN}`, `${TOKEN}/slash`, 'short']) {
      expect(() => resolveConfig([], { [TOKEN_ENV_VAR]: malformed })).toThrow(ConnectorConfigError);
    }
  });

  it('accepts the longest token the endpoint would accept', () => {
    // The local check must never be stricter than `TOKEN_SHAPE` in
    // `apps/mcp/src/auth/token.ts`, or a valid token is refused on the
    // merchant's own machine with no way to tell why.
    const longest = 'a'.repeat(512);

    expect(resolveConfig([], { [TOKEN_ENV_VAR]: longest }).token).toBe(longest);
    expect(() => resolveConfig([], { [TOKEN_ENV_VAR]: 'a'.repeat(513) })).toThrow(ConnectorConfigError);
  });

  it('refuses an endpoint that is not an absolute http or https URL', () => {
    for (const malformed of ['not-a-url', 'ftp://host.example/mcp', '/mcp']) {
      expect(() => resolveConfig([malformed], { [TOKEN_ENV_VAR]: TOKEN })).toThrow(ConnectorConfigError);
    }
  });

  it('does not echo the endpoint it refused, which may be where the token was pasted', () => {
    const malformed = `ftp://host.example/mcp?${TOKEN_QUERY_PARAMETER}=${TOKEN}`;

    try {
      resolveConfig([malformed], {});
      expect.unreachable('a malformed endpoint must be refused');
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as Error).message).toContain(URL_ENV_VAR);
    }
  });

  it('accepts http, because a self-hosted or development endpoint runs on it', () => {
    expect(resolveConfig(['http://localhost:3200/mcp'], { [TOKEN_ENV_VAR]: TOKEN }).endpoint.protocol).toBe('http:');
  });

  it('reads the verbosity from its own variable', () => {
    expect(resolveConfig([], { [TOKEN_ENV_VAR]: TOKEN, [LOG_LEVEL_ENV_VAR]: 'debug' }).logLevel).toBe('debug');
  });

  it('warns about an unrecognised verbosity instead of refusing to start', () => {
    const config = resolveConfig([], { [TOKEN_ENV_VAR]: TOKEN, [LOG_LEVEL_ENV_VAR]: 'verbose' });

    expect(config.logLevel).toBe('info');
    expect(config.warnings.join(' ')).toContain(LOG_LEVEL_ENV_VAR);
  });

  it('does not adopt a LOG_LEVEL meant for the surrounding project', () => {
    // The connector starts in the merchant's own workspace, whose environment
    // frequently already carries a LOG_LEVEL for something else entirely.
    expect(resolveConfig([], { [TOKEN_ENV_VAR]: TOKEN, LOG_LEVEL: 'debug' }).logLevel).toBe('info');
  });
});
