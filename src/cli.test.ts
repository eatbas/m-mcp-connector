import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The executable, asserted from the outside.
 *
 * `cli.ts` cannot be imported: a module carrying a hashbang is a syntax error
 * anywhere a module is wrapped rather than executed, which is precisely why it
 * holds no logic. What it does hold — the hashbang that makes `npx
 * m-mcp-connector` work at all, and the manifest entry that points at it — is
 * invisible to every other test in this suite and breaks silently. So both are
 * pinned here, as text.
 */

const SOURCE_DIRECTORY = new URL('.', import.meta.url);

const HASHBANG = '#!/usr/bin/env node';

interface Manifest {
  readonly bin: Readonly<Record<string, string>>;
  readonly files: readonly string[];
}

function readSource(name: string): string {
  return readFileSync(new URL(name, SOURCE_DIRECTORY), 'utf8');
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(new URL('../package.json', SOURCE_DIRECTORY), 'utf8')) as Manifest;
}

/** Every shipped source in this package: no tests, and no test scaffolding. */
function shippedSources(directory: URL = SOURCE_DIRECTORY, prefix = ''): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return entry.name === 'testing'
        ? []
        : shippedSources(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [`${prefix}${entry.name}`] : [];
  });
}

/**
 * The executable part of a source, with its prose removed.
 *
 * Half the comments in this package discuss `process.stdout` — that is the
 * hazard they exist to explain — so a scan that read them would find nothing
 * but its own documentation. Block comments go first, then whole-line `//`
 * comments; a trailing comment after code is left in place, which can only
 * cause a false positive and never a false negative.
 */
function executablePartOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** A write to the protocol channel, as it would actually be written. */
const PROTOCOL_CHANNEL_WRITE = /console\.(log|info|warn|error|debug|trace|dir|table)\s*\(|process\.stdout/;

describe('the published executable', () => {
  it('starts with a hashbang, which is the only thing making it runnable', () => {
    // `tsc` copies a leading hashbang into `dist/cli.js` verbatim. Nothing else
    // in the build would put one there, and without it npm's symlink on POSIX
    // has no interpreter to hand the file to.
    expect(readSource('cli.ts').startsWith(`${HASHBANG}\n`)).toBe(true);
  });

  it('carries exactly one hashbang, because a second is a syntax error', () => {
    expect(readSource('cli.ts').split(HASHBANG)).toHaveLength(2);
  });

  it('is what the manifest points at, under the documented command name', () => {
    expect(readManifest().bin).toEqual({ 'm-mcp-connector': './dist/cli.js' });
  });

  it('delegates rather than deciding, so that everything it does is testable', () => {
    const source = readSource('cli.ts');

    expect(source).toContain("from './run.js'");
    expect(source).toContain('void main()');
  });
});

describe('the protocol channel', () => {
  it('is written to by no shipped source in this package', () => {
    // The behavioural proof is in `stdio.test.ts`. This is the static one, and
    // it catches the case that one misses: a module added to this package while
    // nobody was running ESLint, whose stray write only shows up as an MCP
    // client that quietly stops responding.
    const offenders = shippedSources()
      .map((name) => ({ name, code: executablePartOf(readSource(name)) }))
      .filter(({ code }) => PROTOCOL_CHANNEL_WRITE.test(code))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('covers every source this package ships, so the scan cannot pass by finding nothing', () => {
    const sources = shippedSources();

    expect(sources).toContain('cli.ts');
    expect(sources).toContain('run.ts');
    expect(sources.length).toBeGreaterThanOrEqual(8);
  });

  it('would notice a write if one were added', () => {
    // The scan's own regression test: without this, deleting the pattern by
    // accident would leave a test that passes because it matches nothing.
    expect(PROTOCOL_CHANNEL_WRITE.test(executablePartOf('const x = 1;\nconsole.log(x);\n'))).toBe(true);
    expect(PROTOCOL_CHANNEL_WRITE.test(executablePartOf('process.stdout.write("x");\n'))).toBe(true);
    expect(PROTOCOL_CHANNEL_WRITE.test(executablePartOf('/* process.stdout is the channel */\n'))).toBe(false);
    expect(PROTOCOL_CHANNEL_WRITE.test(executablePartOf('// never process.stdout\n'))).toBe(false);
    expect(PROTOCOL_CHANNEL_WRITE.test(executablePartOf("const m = 'issue one from the console.';\n"))).toBe(false);
  });
});
