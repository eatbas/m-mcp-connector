/**
 * The Node this connector will run on, checked before anything depends on it.
 *
 * ── Why this is code and not just `engines` ──────────────────────────────────
 *
 * `package.json` declares `engines.node`, and npm only *warns* about it unless
 * the person installing has set `engine-strict`. Almost nobody has. So a
 * merchant on an old Node installs this package successfully, configures it
 * successfully, and then sees their MCP client report a server that failed to
 * start — with whatever syntax or runtime error the oldest unsupported feature
 * happened to raise, which names a line in a dependency and not the cause.
 *
 * One check at the top of `main()` turns that into a sentence naming the
 * version found, the version needed and the fact that the install could not
 * have warned them. It is the same reasoning as `config.ts` checking the token's
 * shape locally rather than letting a truncated paste arrive as a 401.
 *
 * ── Why the major alone ──────────────────────────────────────────────────────
 *
 * The floor is a Node *line*, not a patch: every 22.x carries what this package
 * uses. Comparing majors keeps the check readable and means a merchant on
 * 22.0.0 is not refused over a decimal.
 */

/** The oldest Node line this connector is tested against, matching `engines.node`. */
export const MINIMUM_NODE_MAJOR = 22;

/**
 * Read the leading major out of a Node version string.
 *
 * `process.versions.node` has no `v` prefix, but `process.version` does and the
 * two are easy to confuse at a call site, so both are accepted here rather than
 * relied upon to be right.
 *
 * Exported for its own tests rather than for a caller: {@link isSupportedNode}
 * is the only consumer in this package. The parsing rules — a `v` prefix
 * tolerated, a two-part version refused — are the part worth asserting
 * directly, and asserting them through a function that returns a boolean would
 * mean asserting them by inference.
 *
 * @param version - Something shaped like `22.14.0` or `v22.14.0`.
 * @returns The major, or undefined when the string is not a version at all.
 */
export function nodeMajorOf(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version.trim());
  if (match === null) {
    return undefined;
  }
  return Number(match[1]);
}

/**
 * Whether this Node is new enough.
 *
 * An unreadable version string counts as supported. A connector that refused to
 * start because it could not parse `process.versions.node` would be refusing
 * over its own defect, on a runtime that is almost certainly fine.
 *
 * @param version - The running Node's version.
 * @returns True when the connector will run.
 */
export function isSupportedNode(version: string): boolean {
  const major = nodeMajorOf(version);
  return major === undefined || major >= MINIMUM_NODE_MAJOR;
}

/**
 * The sentence a merchant on an unsupported Node reads.
 *
 * @param version - The running Node's version.
 * @returns One actionable line.
 */
export function unsupportedNodeMessage(version: string): string {
  return (
    `Node ${version.trim()} is too old: this connector needs Node ${String(MINIMUM_NODE_MAJOR)} or newer. ` +
    'Upgrade Node and run the install again. `npm install` does not enforce this by default, which is why ' +
    'nothing warned you at install time.'
  );
}
