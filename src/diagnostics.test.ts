import { describe, expect, it } from 'vitest';

import {
  describeCause,
  describeEndpoint,
  describeError,
  REDACTED,
  redactSecrets,
  redactTokenFromUrl,
  TOKEN_QUERY_PARAMETER,
} from './diagnostics.js';

const SECRET = 'mcp_test_abcdefghijklmnop';

describe('redactSecrets', () => {
  it('removes every occurrence, not just the first', () => {
    const text = `token=${SECRET} retried with ${SECRET}`;

    const redacted = redactSecrets(text, [SECRET]);

    expect(redacted).not.toContain(SECRET);
    expect(redacted).toBe(`token=${REDACTED} retried with ${REDACTED}`);
  });

  it('removes a secret that arrived inside a larger string', () => {
    // The case the call sites cannot be reviewed for: the value reaching the log
    // through an error message rather than through a named field.
    const text = JSON.stringify({ msg: `GET https://host/mcp?p=${SECRET} failed` });

    expect(redactSecrets(text, [SECRET])).not.toContain(SECRET);
  });

  it('leaves text alone when no secret is registered', () => {
    expect(redactSecrets('nothing to hide', [])).toBe('nothing to hide');
  });

  it('ignores a blank secret rather than replacing between every character', () => {
    // `''.replaceAll` would otherwise insert the replacement at every position
    // and destroy the line.
    expect(redactSecrets('abc', [''])).toBe('abc');
  });

  it('ignores an implausibly short secret rather than mangling unrelated text', () => {
    expect(redactSecrets('the id field', ['id'])).toBe('the id field');
  });
});

describe('redactTokenFromUrl', () => {
  it('replaces the token parameter and keeps everything else', () => {
    const redacted = redactTokenFromUrl(`https://host.example/mcp?${TOKEN_QUERY_PARAMETER}=${SECRET}&debug=1`);

    expect(redacted).toBe(`https://host.example/mcp?${TOKEN_QUERY_PARAMETER}=${REDACTED}&debug=1`);
  });

  it('leaves a target with no token parameter exactly as it was', () => {
    expect(redactTokenFromUrl('/mcp')).toBe('/mcp');
  });

  it('redacts a relative target without inventing an origin for it', () => {
    expect(redactTokenFromUrl(`/mcp?${TOKEN_QUERY_PARAMETER}=${SECRET}`)).toBe(
      `/mcp?${TOKEN_QUERY_PARAMETER}=${REDACTED}`,
    );
  });

  it('replaces an unparseable target wholesale rather than passing it through', () => {
    // If the query string cannot be seen, no promise can be made about what is
    // in it.
    expect(redactTokenFromUrl('http://[')).toBe(REDACTED);
  });
});

describe('describeEndpoint', () => {
  it('drops the query string, which is where a token would be', () => {
    const url = new URL(`https://host.example/mcp?${TOKEN_QUERY_PARAMETER}=${SECRET}#fragment`);

    const described = describeEndpoint(url);

    expect(described).toBe('https://host.example/mcp');
    expect(described).not.toContain(SECRET);
  });
});

describe('describeError', () => {
  it('returns the message and never the stack', () => {
    const error = new Error('the endpoint refused');

    expect(describeError(error)).toBe('the endpoint refused');
    expect(describeError(error)).not.toContain('at ');
  });

  it('renders a thrown string and a thrown non-error', () => {
    expect(describeError('plain')).toBe('plain');
    expect(describeError(404)).toBe('404');
  });
});

describe('describeCause', () => {
  it('digs the error code out of a failed fetch, which reports only "fetch failed"', () => {
    const failure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3200'), { code: 'ECONNREFUSED' }),
    });

    expect(describeCause(failure)).toBe('ECONNREFUSED');
  });

  it('falls back to the cause message when there is no code', () => {
    expect(describeCause(new Error('outer', { cause: new Error('inner') }))).toBe('inner');
  });

  it('falls back to the error itself when there is no cause', () => {
    expect(describeCause(new Error('alone'))).toBe('alone');
  });
});
