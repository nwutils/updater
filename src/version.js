/*
 * Minimal semantic version comparison. NW.js can't resolve bare package
 * imports (eg. `semver`) from the application's browser context, so the
 * updater only depends on Node.js built-in modules.
 */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * @param {unknown} version
 * @returns {{core: number[], prerelease: string[]} | null}
 */
function parse(version) {
  if (typeof version !== 'string') {
    return null;
  }
  const match = SEMVER.exec(version.trim());
  if (match === null) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/**
 * Check if `version` is a valid semantic version, eg. `1.2.3`, `v1.2.3` or `1.2.3-beta.1`.
 * @param {unknown} version
 * @returns {boolean}
 */
function valid(version) {
  return parse(version) !== null;
}

/**
 * Compare two pre-release identifiers per the semver spec.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareIdentifiers(a, b) {
  const aIsNumber = /^\d+$/.test(a);
  const bIsNumber = /^\d+$/.test(b);
  if (aIsNumber && bIsNumber) {
    return Number(a) - Number(b);
  }
  if (aIsNumber !== bIsNumber) {
    return aIsNumber ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Check if version `a` is greater than version `b`.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 * @throws {Error} If either version is not a valid semantic version.
 */
function gt(a, b) {
  const parsedA = parse(a);
  const parsedB = parse(b);
  if (parsedA === null || parsedB === null) {
    throw new Error(`Invalid semantic version: ${JSON.stringify(parsedA === null ? a : b)}`);
  }

  for (let i = 0; i < 3; i++) {
    if (parsedA.core[i] !== parsedB.core[i]) {
      return parsedA.core[i] > parsedB.core[i];
    }
  }

  /* A version without a pre-release is greater than one with, eg. 1.0.0 > 1.0.0-beta. */
  if (parsedA.prerelease.length === 0 || parsedB.prerelease.length === 0) {
    return parsedA.prerelease.length === 0 && parsedB.prerelease.length > 0;
  }
  const length = Math.max(parsedA.prerelease.length, parsedB.prerelease.length);
  for (let i = 0; i < length; i++) {
    if (parsedA.prerelease[i] === undefined || parsedB.prerelease[i] === undefined) {
      return parsedB.prerelease[i] === undefined;
    }
    const comparison = compareIdentifiers(parsedA.prerelease[i], parsedB.prerelease[i]);
    if (comparison !== 0) {
      return comparison > 0;
    }
  }
  return false;
}

export default { gt, valid };
