/**
 * The identity this package reports about itself.
 *
 * Kept as source rather than imported from `package.json`, because `tsc` builds
 * this package with `rootDir: src` and a manifest import would either drag the
 * whole manifest into `dist/` or push the emit root up a directory. The two
 * strings are pinned to the manifest by `version.test.ts`, so a release that
 * bumps one and not the other fails a test rather than shipping a connector
 * that lies about which build it is.
 *
 * Neither value reaches the MCP client: `bridge.ts` forwards the *hosted*
 * server's own identity, so that a merchant's client names the service they are
 * actually talking to. These two are for the start-up line on stderr and for
 * the `clientInfo` the hosted endpoint sees, which is where knowing the
 * connector's build actually helps.
 */

/**
 * npm package name, and the `clientInfo.name` the hosted endpoint is told.
 *
 * Not a cosmetic string. It is the `name` field on every line this connector
 * logs, and it is what `apps/mcp` records as the calling client, so it is the
 * only handle an operator has on "which build is this merchant running". A
 * change to it is a change to the gateway's own records, not a rename.
 *
 * The scope is deliberately not the `@m-mcp` one the rest of this workspace
 * uses: every other member is private and may be named anything, while this one
 * is published and has to sit in a scope that is actually owned.
 */
export const CONNECTOR_NAME = '@atbas/m-mcp-connector';

/** Kept in step with `package.json`'s `version` by `version.test.ts`. */
export const CONNECTOR_VERSION = '1.1.0';
