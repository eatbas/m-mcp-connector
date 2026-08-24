import { describe, expect, it } from 'vitest';

import { isSupportedNode, MINIMUM_NODE_MAJOR, nodeMajorOf, unsupportedNodeMessage } from './node-version.js';

describe('nodeMajorOf', () => {
  it('reads the major from the form `process.versions.node` uses', () => {
    expect(nodeMajorOf('22.14.0')).toBe(22);
  });

  it('reads the major from the form `process.version` uses', () => {
    // The two are one property name apart and easy to confuse at a call site.
    expect(nodeMajorOf('v24.1.0')).toBe(24);
  });

  it('returns undefined for anything that is not a version', () => {
    expect(nodeMajorOf('')).toBeUndefined();
    expect(nodeMajorOf('unknown')).toBeUndefined();
    expect(nodeMajorOf('22')).toBeUndefined();
  });
});

describe('isSupportedNode', () => {
  it('accepts the floor exactly', () => {
    expect(isSupportedNode(`${String(MINIMUM_NODE_MAJOR)}.0.0`)).toBe(true);
  });

  it('accepts anything above the floor', () => {
    expect(isSupportedNode(`${String(MINIMUM_NODE_MAJOR + 2)}.10.1`)).toBe(true);
  });

  it('refuses anything below it', () => {
    expect(isSupportedNode(`${String(MINIMUM_NODE_MAJOR - 1)}.19.0`)).toBe(false);
    expect(isSupportedNode('18.0.0')).toBe(false);
  });

  it('accepts a version it cannot read', () => {
    // Refusing to start because the connector could not parse its own runtime's
    // version would be refusing over its own defect, on a Node almost certainly
    // fine.
    expect(isSupportedNode('unknown')).toBe(true);
  });

  it('accepts the Node this suite is running on', () => {
    expect(isSupportedNode(process.versions.node)).toBe(true);
  });
});

describe('unsupportedNodeMessage', () => {
  it('names the version found, the version needed and why nothing warned them', () => {
    const message = unsupportedNodeMessage('20.19.0');

    expect(message).toContain('20.19.0');
    expect(message).toContain(String(MINIMUM_NODE_MAJOR));
    expect(message).toContain('does not enforce this by default');
  });
});
