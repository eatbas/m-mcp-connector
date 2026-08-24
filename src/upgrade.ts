import { CONNECTOR_NAME, CONNECTOR_VERSION } from './version.js';

/**
 * Telling a merchant that the connector they installed has been superseded.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 *
 * This package is installed globally and updated by hand. Nothing re-resolves
 * it, nothing expires it, and a merchant who ran `npm i -g` once has no reason
 * to think about it again — so a build from a year ago keeps running until
 * something tells its owner otherwise. The hosted endpoint is the only party in
 * a position to say so: it sees every session and it knows which version is
 * current, which it advertises on {@link LATEST_VERSION_HEADER}.
 *
 * ── Why it is advice and never enforcement ───────────────────────────────────
 *
 * An old connector is a pure JSON-RPC pass-through and works perfectly well. A
 * connector that refused to run when it was behind would turn a routine release
 * into an outage for every merchant who had not updated that morning, and a
 * gateway able to cause that is a gateway one bad constant away from locking
 * everybody out. So this produces one line on stderr and changes nothing else.
 *
 * ── Why every doubt resolves to silence ──────────────────────────────────────
 *
 * A missing header, an unparseable one, an equal version, or a version older
 * than this build all produce no advice. The last case is the one worth naming:
 * a self-hosted or lagging gateway must never make a current connector tell its
 * owner to downgrade.
 */

/** The response header the hosted endpoint advertises the newest release on. */
export const LATEST_VERSION_HEADER = 'x-m-mcp-connector-latest';

/** `major.minor.patch`, ignoring any pre-release or build suffix. */
type VersionParts = readonly [number, number, number];

/**
 * Read the leading `major.minor.patch` out of a version string.
 *
 * Anything that does not begin with three dot-separated integers is
 * `undefined`. A suffix is ignored rather than refused: `1.2.0-rc.1` is a
 * 1.2.0-series build for the purpose of "is there something newer", and
 * refusing to parse it would mean a pre-release install never hears about the
 * release that supersedes it.
 *
 * @param value - A version string, or whatever arrived in the header.
 * @returns The three leading numbers, or undefined when they are not there.
 */
function parseVersion(value: string | null | undefined): VersionParts | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) {
    return undefined;
  }

  // The pattern has three capturing groups and matched, so all three are
  // present; `noUncheckedIndexedAccess` cannot see that, hence the defaults.
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * Whether `candidate` is strictly newer than `current`.
 *
 * @param candidate - The advertised version.
 * @param current - The running version.
 * @returns True when the connector is behind.
 */
function isNewer(candidate: VersionParts, current: VersionParts): boolean {
  const differs = candidate.findIndex((part, index) => part !== current[index]);
  return differs !== -1 && candidate[differs] !== undefined && candidate[differs] > (current[differs] ?? 0);
}

/**
 * Decide whether to advise an upgrade, and say so in one sentence.
 *
 * Exported for its own tests rather than for a caller: {@link createUpgradeNotifier}
 * is the only consumer in this package. Every rule in the header comment above
 * — silence on a missing header, an unparseable one, an equal version, an older
 * one — is a rule about THIS function, and testing them through the notifier
 * would mean testing them through a once-only latch that exists for an
 * unrelated reason.
 *
 * @param advertised - The raw header value, or null/undefined when absent.
 * @param current - The running connector's version. Defaults to this build's.
 * @returns The sentence to log, or undefined when there is nothing to say.
 */
export function upgradeAdvice(
  advertised: string | null | undefined,
  current: string = CONNECTOR_VERSION,
): string | undefined {
  const latest = parseVersion(advertised);
  const running = parseVersion(current);

  if (latest === undefined || running === undefined || !isNewer(latest, running)) {
    return undefined;
  }

  // The version strings are the endpoint's and this build's own, never anything
  // a merchant typed, so neither can carry a credential into a log line.
  return (
    `A newer connector is available: you are running ${current} and ${advertised?.trim() ?? ''} is current. ` +
    `Update with: npm i -g ${CONNECTOR_NAME}`
  );
}

/**
 * The advice, at most once per process.
 *
 * Every forwarded request carries the header, so an unguarded warning would
 * repeat on every tool call for the whole life of the session — which is how a
 * useful line becomes noise a merchant filters out.
 *
 * @returns A function that returns the sentence the first time it is warranted, and undefined afterwards.
 */
export function createUpgradeNotifier(
  current: string = CONNECTOR_VERSION,
): (advertised: string | null) => string | undefined {
  let announced = false;

  return (advertised): string | undefined => {
    if (announced) {
      return undefined;
    }

    const advice = upgradeAdvice(advertised, current);
    if (advice === undefined) {
      return undefined;
    }

    announced = true;
    return advice;
  };
}
