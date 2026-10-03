import assert from "node:assert/strict";
import { describe, it } from "node:test";

import version from "../../src/version.js";

describe("version", function () {
    it("validates semantic versions", function () {
        for (const valid of ["1.2.3", "v1.2.3", "1.2.3-beta.1", "1.2.3+build.5", "1.2.3-rc.1+build"]) {
            assert.strictEqual(version.valid(valid), true, valid);
        }
        for (const invalid of ["1.2", "latest", "1.2.3.4", "", undefined, 1]) {
            assert.strictEqual(version.valid(invalid), false, String(invalid));
        }
    });

    it("orders versions per the semver spec", function () {
        /* Each version is greater than the one before it. */
        const ordered = [
            "0.9.9",
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.1",
            "1.1.0",
            "1.10.0",
            "2.0.0",
        ];
        for (let i = 1; i < ordered.length; i++) {
            assert.strictEqual(version.gt(ordered[i], ordered[i - 1]), true, `${ordered[i]} > ${ordered[i - 1]}`);
            assert.strictEqual(version.gt(ordered[i - 1], ordered[i]), false, `${ordered[i - 1]} > ${ordered[i]}`);
        }
        assert.strictEqual(version.gt("1.0.0", "v1.0.0"), false);
        assert.strictEqual(version.gt("1.0.0+build.2", "1.0.0+build.1"), false);
    });

    it("throws on invalid versions", function () {
        assert.throws(() => version.gt("latest", "1.0.0"), /Invalid semantic version: "latest"/);
    });
});
