/**
 * The package's public surface.
 *
 * `@atbas/m-mcp-connector` is first of all an executable: almost every install
 * runs `m-mcp-connector` from an MCP client's configuration and imports nothing.
 * What is exported here is therefore only what a *host process* needs in order
 * to run the same connector in-process rather than spawning it — an MCP client
 * written in TypeScript, or this repository's own end-to-end tests.
 *
 * Everything else stays internal on purpose. The bridge, the endpoint client,
 * the redaction helpers and the logger are implementation, and exporting them
 * would turn a refactor of any one of them into a breaking change for a
 * published package.
 */

export { resolveConfig, ConnectorConfigError, DEFAULT_ENDPOINT_URL, TOKEN_ENV_VAR, URL_ENV_VAR } from './config.js';
export type { ConnectorConfig, TokenSource } from './config.js';
export { LOG_LEVEL_ENV_VAR } from './logger.js';
export type { Logger, LogLevel } from './logger.js';
export { RemoteConnectionError } from './remote.js';
export type { RemoteFailureKind, RetryPolicy } from './remote.js';
export { createConnectorLogger, main, registerShutdownHandlers, startConnector } from './run.js';
export type { MainOptions, RunningConnector, StartConnectorOptions } from './run.js';
export { CONNECTOR_NAME, CONNECTOR_VERSION } from './version.js';
