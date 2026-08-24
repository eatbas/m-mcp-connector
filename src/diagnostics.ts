/**
 * Turning values into text that is safe to put in front of a person.
 *
 * Every diagnostic this connector emits passes through here first, and the
 * reason is narrower than "tidiness". The connector is spawned by an MCP client
 * — Claude Desktop is the one that matters — which captures its stderr verbatim
 * into a log pane that is neither redacted nor short-lived, and which merchants
 * copy into support threads. Anything written there should be assumed to be
 * published.
 *
 * Two things therefore never appear in output:
 *
 *  1. **The access token**, in whole or in part. A prefix is not a safe
 *     compromise: it narrows a search. {@link redactSecrets} is applied by
 *     `logger.ts` to every line, after serialisation, so that a value which
 *     reached a message through a route nobody anticipated — an error's own
 *     text, a URL inside a `cause` — is still removed.
 *  2. **A stack trace.** Frames are noise in a client log pane, and a frame
 *     that captured a configuration value would carry it there. Errors are
 *     reduced to their message by {@link describeError}.
 */

/** What a redacted value is replaced with. Matches `apps/mcp/src/auth/token.ts`. */
export const REDACTED = '***';

/**
 * Query parameter carrying the access token.
 *
 * The same single letter `apps/mcp/src/auth/token.ts` reads, restated rather
 * than imported: this package is published on its own and deliberately depends
 * on nothing in this workspace, so that a merchant installing it pulls the MCP
 * SDK and nothing else. The two must be changed together; `config.test.ts`
 * records the coupling.
 */
export const TOKEN_QUERY_PARAMETER = 'p';

/**
 * Shortest value {@link redactSecrets} will scrub.
 *
 * A blank string would make `replaceAll` insert the replacement between every
 * character, and a short one would mangle unrelated text — "id" appearing in
 * every line, for instance. Nothing this connector treats as a secret is
 * anywhere near this short: the hosted endpoint refuses any token below sixteen
 * characters, so the floor costs nothing real and removes both failure modes.
 */
const SHORTEST_SCRUBBABLE_SECRET = 8;

/** Base for parsing a request target that arrives as a path rather than a URL. */
const RELATIVE_URL_BASE = 'http://request.invalid';

/**
 * Remove every occurrence of every secret from `text`.
 *
 * Applied to a serialised log line rather than to the values that went into it,
 * so it catches a secret that arrived by a route the call site did not
 * anticipate. It is the second line of defence, never the first: no call site in
 * this package passes a token to the logger in the first place.
 *
 * @param text - Text about to be written somewhere a person can read it.
 * @param secrets - Values to remove. Blank and implausibly short entries are ignored.
 * @returns `text` with every secret replaced by {@link REDACTED}.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;

  for (const secret of secrets) {
    if (secret.length < SHORTEST_SCRUBBABLE_SECRET) {
      continue;
    }
    redacted = redacted.replaceAll(secret, REDACTED);
  }

  return redacted;
}

/**
 * Rewrite a URL so that the token it may carry does not travel with it.
 *
 * The mirror of `redactTokenFromUrl` in `apps/mcp/src/server.ts`, and needed
 * for the same reason: `?p=<token>` is a bearer credential in a URL, and a URL
 * is the most widely copied string in an HTTP stack.
 *
 * A target that cannot be parsed is replaced wholesale rather than returned
 * unchanged — a function that cannot see the query string cannot promise there
 * is no token in it.
 *
 * @param target - An absolute URL, or a path with an optional query.
 * @returns The same target with `p`'s value replaced, or {@link REDACTED} if it could not be parsed.
 */
export function redactTokenFromUrl(target: string): string {
  let parsed: URL;
  try {
    parsed = new URL(target, RELATIVE_URL_BASE);
  } catch {
    return REDACTED;
  }

  if (!parsed.searchParams.has(TOKEN_QUERY_PARAMETER)) {
    return target;
  }

  // `set` overwrites the first occurrence in place and drops any repeats, so the
  // redacted target keeps the parameter order the original had.
  parsed.searchParams.set(TOKEN_QUERY_PARAMETER, REDACTED);
  return URL.canParse(target) ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Origin and path of an endpoint, with the query string and fragment dropped.
 *
 * Used wherever a message names the endpoint. Dropping the query is what makes
 * the label safe to print unconditionally: a merchant who configured the
 * connector with `?p=<token>` would otherwise have that token echoed back by the
 * very line telling them the endpoint was unreachable.
 *
 * @param url - The configured endpoint.
 * @returns `https://host/path`, with no credential in it.
 */
export function describeEndpoint(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/**
 * One line describing a thrown value, with no stack and no nesting.
 *
 * @param error - Anything a `catch` produced.
 * @returns The error's message, or a printable rendering of a non-`Error` throw.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

/**
 * The most useful fragment a failed `fetch` carries.
 *
 * `fetch` reports "fetch failed" and hangs the real reason off `cause`, so
 * `ECONNREFUSED` — the one word that tells a merchant to check the URL or their
 * proxy — is reachable only through it.
 *
 * @param error - Anything a `catch` produced.
 * @returns The cause's error code where there is one, otherwise the best available message.
 */
export function describeCause(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;

  if (cause instanceof Error) {
    return 'code' in cause && typeof cause.code === 'string' ? cause.code : cause.message;
  }

  return describeError(error);
}
