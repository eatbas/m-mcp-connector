import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CONNECTOR_NAME, CONNECTOR_VERSION } from './version.js';

/**
 * The manifest is the authority; these constants are a copy of two of its
 * fields that `tsc` can inline. This is what stops the copy drifting.
 *
 * The manifest fields asserted below it are the ones a publish depends on and
 * nothing else checks. `engines.node` is the floor `run.ts` enforces in code —
 * npm only warns about it unless a consumer sets `engine-strict` — and
 * `repository` is what npm validates a provenance attestation against, which it
 * can only do when the URL names the public mirror and carries no `directory`.
 */
interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly bin: Readonly<Record<string, string>>;
  readonly engines: { readonly node: string };
  readonly repository: { readonly type: string; readonly url: string; readonly directory?: string };
  readonly files: readonly string[];
}

/** The repository the publish runs in, and the only one npm will attest against. */
const MIRROR_REPOSITORY_URL = 'git+https://github.com/eatbas/m-mcp-connector.git';

function readManifest(): Manifest {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Manifest;
}

describe('the connector identity', () => {
  it('matches the published package name', () => {
    expect(CONNECTOR_NAME).toBe(readManifest().name);
  });

  it('matches the published version', () => {
    expect(CONNECTOR_VERSION).toBe(readManifest().version);
  });
});

describe('the published manifest', () => {
  it('declares the Node floor the connector enforces at start-up', () => {
    expect(readManifest().engines.node).toBe('>=22.0.0');
  });

  it('points provenance at the public mirror', () => {
    const { repository } = readManifest();

    expect(repository.url).toBe(MIRROR_REPOSITORY_URL);
    // Not merely absent-by-accident: a `directory` would make npm look for the
    // package in a sub-directory of the mirror, where it is not, and the
    // attestation would fail on a run that has already published.
    expect(repository.directory).toBeUndefined();
  });

  it('ships the licence alongside the build', () => {
    expect(readManifest().files).toContain('LICENSE');
  });
});
