import { describe, expect, it } from 'vitest';

import * as connector from './index.js';

/**
 * The public surface of a published package, pinned.
 *
 * Widening it is a decision — every name here is something a consumer may
 * depend on and this package may then no longer refactor freely — so widening
 * it should cost an edit to this list rather than happening as a side effect of
 * adding an export somewhere.
 */
const PUBLIC_SURFACE = [
  'CONNECTOR_NAME',
  'CONNECTOR_VERSION',
  'ConnectorConfigError',
  'DEFAULT_ENDPOINT_URL',
  'LOG_LEVEL_ENV_VAR',
  'RemoteConnectionError',
  'TOKEN_ENV_VAR',
  'URL_ENV_VAR',
  'createConnectorLogger',
  'main',
  'registerShutdownHandlers',
  'resolveConfig',
  'startConnector',
].sort((left, right) => left.localeCompare(right));

/** Implementation. Exporting any of these would make a refactor a breaking change. */
const MUST_STAY_INTERNAL = ['createBridge', 'advertisedCapabilities', 'connectRemote', 'createLogger', 'redactSecrets'];

describe('the package entry point', () => {
  it('exports exactly the surface it means to', () => {
    expect(Object.keys(connector).sort((left, right) => left.localeCompare(right))).toEqual(PUBLIC_SURFACE);
  });

  it('keeps the implementation out of the surface', () => {
    for (const name of MUST_STAY_INTERNAL) {
      expect(Object.keys(connector)).not.toContain(name);
    }
  });

  it('exports a runnable entry point and the identity a host process reports', () => {
    expect(typeof connector.main).toBe('function');
    expect(typeof connector.startConnector).toBe('function');
    expect(connector.CONNECTOR_NAME).toBe('@atbas/m-mcp-connector');
  });
});
