import { describe, expect, it } from 'vitest';

import { createUpgradeNotifier, upgradeAdvice } from './upgrade.js';
import { CONNECTOR_NAME, CONNECTOR_VERSION } from './version.js';

/**
 * The rule this suite exists to hold: **every doubt resolves to silence.**
 *
 * A false positive here tells a merchant to run an install that changes
 * nothing, or — worse, in the older-gateway case — to downgrade. Advice nobody
 * should act on is worse than no advice, because the next real notice is read
 * as more of the same.
 */
describe('upgradeAdvice', () => {
  it('advises when the endpoint advertises something newer', () => {
    const advice = upgradeAdvice('1.4.0', '1.2.3');

    expect(advice).toContain('1.2.3');
    expect(advice).toContain('1.4.0');
    expect(advice).toContain(`npm i -g ${CONNECTOR_NAME}`);
  });

  it('advises on a newer major and on a newer patch alike', () => {
    expect(upgradeAdvice('2.0.0', '1.9.9')).toBeDefined();
    expect(upgradeAdvice('1.0.1', '1.0.0')).toBeDefined();
  });

  it('says nothing when the versions match', () => {
    expect(upgradeAdvice('1.2.3', '1.2.3')).toBeUndefined();
  });

  it('says nothing when the endpoint advertises something older', () => {
    // A self-hosted or lagging gateway must never make a current connector tell
    // its owner to downgrade.
    expect(upgradeAdvice('1.0.0', '1.2.3')).toBeUndefined();
    expect(upgradeAdvice('1.2.2', '1.2.3')).toBeUndefined();
  });

  it('says nothing when the header is absent', () => {
    expect(upgradeAdvice(null, '1.2.3')).toBeUndefined();
    expect(upgradeAdvice(undefined, '1.2.3')).toBeUndefined();
  });

  it('says nothing when the header is not a version', () => {
    expect(upgradeAdvice('', '1.2.3')).toBeUndefined();
    expect(upgradeAdvice('latest', '1.2.3')).toBeUndefined();
    expect(upgradeAdvice('1.2', '1.2.3')).toBeUndefined();
    expect(upgradeAdvice('<html>404</html>', '1.2.3')).toBeUndefined();
  });

  it('reads a pre-release as its own series rather than refusing it', () => {
    // Refusing to parse a suffix would mean a pre-release install never hears
    // about the release that supersedes it.
    expect(upgradeAdvice('1.3.0', '1.3.0-rc.1')).toBeUndefined();
    expect(upgradeAdvice('1.4.0-rc.1', '1.3.0')).toBeDefined();
  });

  it('tolerates surrounding whitespace, which a proxy may add', () => {
    expect(upgradeAdvice(' 1.4.0 ', '1.2.3')).toBeDefined();
  });

  it('defaults to this build when no current version is given', () => {
    expect(upgradeAdvice(CONNECTOR_VERSION)).toBeUndefined();
  });
});

describe('createUpgradeNotifier', () => {
  it('advises once and then stays quiet', () => {
    // Every forwarded request carries the header, so an unguarded warning would
    // repeat for the whole life of the session.
    const notify = createUpgradeNotifier('1.0.0');

    expect(notify('1.1.0')).toBeDefined();
    expect(notify('1.1.0')).toBeUndefined();
    expect(notify('1.2.0')).toBeUndefined();
  });

  it('stays available until there is something to say', () => {
    const notify = createUpgradeNotifier('1.0.0');

    expect(notify(null)).toBeUndefined();
    expect(notify('1.0.0')).toBeUndefined();
    expect(notify('1.1.0')).toBeDefined();
    expect(notify('1.1.0')).toBeUndefined();
  });
});
