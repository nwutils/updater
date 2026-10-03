import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import AppImageUpdater, { parseYaml, updateInfoFileName } from "../../src/appImage.js";

describe("AppImageUpdater", function () {
    const newAppImage = Buffer.from("new AppImage contents");
    const newAppImageSha512 = crypto.createHash("sha512").update(newAppImage).digest("base64");
    const updateInfo = [
        "version: \"1.2.0\"",
        "files:",
        "  - url: \"Demo-x86_64.AppImage\"",
        `    sha512: "${newAppImageSha512}"`,
        `    size: ${newAppImage.length}`,
        "path: \"Demo-x86_64.AppImage\"",
        `sha512: "${newAppImageSha512}"`,
        "releaseDate: \"2026-10-03T00:00:00.000Z\"",
        "",
    ].join("\n");

    /** @type {Record<string, string | Buffer>} */
    let routes = {};
    const server = http.createServer((req, res) => {
        const body = routes[/** @type {string} */ (req.url)];
        if (body === undefined) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { "Content-Length": Buffer.byteLength(body) }).end(body);
    });
    let baseUrl = "";

    let tmpDir = "";
    let appImagePath = "";
    let configPath = "";
    let temporaryDirectory = "";

    before(async function () {
        await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
        const address = /** @type {import("node:net").AddressInfo} */ (server.address());
        baseUrl = `http://127.0.0.1:${address.port}`;

        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nwutils-updater-appimage-test-"));
    });

    beforeEach(async function () {
        routes = {
            [`/releases/${updateInfoFileName(process.arch)}`]: updateInfo,
            "/releases/Demo-x86_64.AppImage": newAppImage,
        };
        appImagePath = path.join(tmpDir, "apps", "Demo-x86_64.AppImage");
        await fs.promises.mkdir(path.dirname(appImagePath), { recursive: true });
        await fs.promises.writeFile(appImagePath, "old AppImage contents", { mode: 0o755 });
        configPath = path.join(tmpDir, "app-update.yml");
        await fs.promises.writeFile(configPath, `provider: "generic"\nurl: "${baseUrl}/releases/"\n`);
        temporaryDirectory = path.join(tmpDir, "downloads");
    });

    after(async function () {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    /**
     * @param {import("../../src/appImage.js").AppImageUpdaterOptions} [options]
     * @returns {AppImageUpdater}
     */
    function createUpdater(options) {
        return new AppImageUpdater({
            currentVersion: "1.1.0",
            appImagePath,
            configPath,
            temporaryDirectory,
            ...options,
        });
    }

    describe("parseYaml", function () {
        it("parses files written by @nwutils/packager", function () {
            assert.deepStrictEqual(parseYaml(updateInfo), {
                version: "1.2.0",
                files: [{ url: "Demo-x86_64.AppImage", sha512: newAppImageSha512, size: newAppImage.length }],
                path: "Demo-x86_64.AppImage",
                sha512: newAppImageSha512,
                releaseDate: "2026-10-03T00:00:00.000Z",
            });
        });

        it("parses files written by electron-builder", function () {
            const contents = [
                "version: 1.2.0",
                "files:",
                "  - url: Demo-1.2.0.AppImage",
                "    sha512: abc+/==",
                "    size: 10",
                "    blockMapSize: 2",
                "  - url: Demo-1.2.0.zip",
                "    sha512: def",
                "path: Demo-1.2.0.AppImage",
                "sha512: abc+/==",
                "releaseDate: '2026-10-03T00:00:00.000Z'",
                "",
            ].join("\n");

            assert.deepStrictEqual(parseYaml(contents), {
                version: "1.2.0",
                files: [
                    { url: "Demo-1.2.0.AppImage", sha512: "abc+/==", size: 10, blockMapSize: 2 },
                    { url: "Demo-1.2.0.zip", sha512: "def" },
                ],
                path: "Demo-1.2.0.AppImage",
                sha512: "abc+/==",
                releaseDate: "2026-10-03T00:00:00.000Z",
            });
        });
    });

    describe("updateInfoFileName", function () {
        it("matches @nwutils/packager's naming", function () {
            assert.strictEqual(updateInfoFileName("x64"), "latest-linux.yml");
            assert.strictEqual(updateInfoFileName("arm64"), "latest-linux-arm64.yml");
        });
    });

    describe("manifest method", function () {
        it("throws on an unknown method", function () {
            assert.throws(
                () => createUpdater({ method: /** @type {"zsync"} */ (/** @type {unknown} */ ("bsdiff")) }),
                /Expected "options.method" to be "manifest" or "zsync"/,
            );
        });

        it("throws when not running from an AppImage", async function () {
            await assert.rejects(
                createUpdater({ appImagePath: "" }).checkForUpdates(),
                /not running from an AppImage/,
            );
        });

        it("throws when app-update.yml is missing", async function () {
            await assert.rejects(
                createUpdater({ configPath: path.join(tmpDir, "nope.yml") }).checkForUpdates(),
                /Was the AppImage packaged with "publish" set\?/,
            );
        });

        it("throws when currentVersion is not a semantic version", async function () {
            await assert.rejects(
                createUpdater({ currentVersion: "latest" }).checkForUpdates(),
                /Expected "options.currentVersion" to be a valid semantic version/,
            );
        });

        it("finds a newer version", async function () {
            const update = await createUpdater().checkForUpdates();

            assert.deepStrictEqual(update, {
                updateAvailable: true,
                version: "1.2.0",
                url: `${baseUrl}/releases/Demo-x86_64.AppImage`,
                sha512: newAppImageSha512,
                size: newAppImage.length,
                releaseDate: "2026-10-03T00:00:00.000Z",
            });
        });

        it("reports no update for the same version", async function () {
            const update = await createUpdater({ currentVersion: "1.2.0" }).checkForUpdates();

            assert.strictEqual(update.updateAvailable, false);
        });

        it("looks up GitHub releases via the latest release's download URL", async function () {
            await fs.promises.writeFile(configPath, "provider: \"github\"\nowner: \"nwutils\"\nrepo: \"demo\"\n");
            const originalFetch = globalThis.fetch;
            /** @type {string[]} */
            const requestedUrls = [];
            globalThis.fetch = async (url) => {
                requestedUrls.push(String(url));
                return new Response(updateInfo);
            };
            try {
                const update = await createUpdater().checkForUpdates();

                assert.deepStrictEqual(requestedUrls, [
                    `https://github.com/nwutils/demo/releases/latest/download/${updateInfoFileName(process.arch)}`,
                ]);
                assert.strictEqual(update.url, "https://github.com/nwutils/demo/releases/latest/download/Demo-x86_64.AppImage");
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("downloads and verifies the update, reporting progress", async function () {
            const updater = createUpdater();
            const update = await updater.checkForUpdates();
            /** @type {import("../../src/appImage.js").DownloadProgress[]} */
            const progress = [];

            const filePath = await updater.downloadUpdate(update, { onProgress: (p) => progress.push(p) });

            assert.ok(filePath.startsWith(temporaryDirectory));
            assert.deepStrictEqual(await fs.promises.readFile(filePath), newAppImage);
            assert.deepStrictEqual(progress.at(-1), { transferred: newAppImage.length, total: newAppImage.length });
        });

        it("rejects and removes a download that doesn't match the published digest", async function () {
            const updater = createUpdater();
            const update = await updater.checkForUpdates();
            routes["/releases/Demo-x86_64.AppImage"] = Buffer.from("tampered AppImage ...");

            await assert.rejects(
                updater.downloadUpdate(update),
                /does not match the published size and SHA-512 digest/,
            );
            assert.deepStrictEqual(await fs.promises.readdir(temporaryDirectory), []);
        });

        it("installs the update over the running AppImage", async function () {
            const updater = createUpdater();
            const filePath = await updater.downloadUpdate(await updater.checkForUpdates());

            await updater.install(filePath);

            assert.deepStrictEqual(await fs.promises.readFile(appImagePath), newAppImage);
            assert.ok((await fs.promises.stat(appImagePath)).mode & 0o111, "installed AppImage should be executable");
            assert.strictEqual(fs.existsSync(filePath), false, "downloaded file should be removed");
            assert.deepStrictEqual(await fs.promises.readdir(path.dirname(appImagePath)), ["Demo-x86_64.AppImage"]);
        });
    });

    describe("zsync method", function () {
        let fakeTool = "";

        before(async function () {
            /* Exits with the code in FAKE_EXIT_CODE and logs its arguments. */
            fakeTool = path.join(tmpDir, "fake-appimageupdatetool");
            await fs.promises.writeFile(
                fakeTool,
                `#!/bin/sh\necho "$@" > "${path.join(tmpDir, "fake-appimageupdatetool.args")}"\nexit "\${FAKE_EXIT_CODE:-0}"\n`,
                { mode: 0o755 },
            );
        });

        afterEach(function () {
            delete process.env.FAKE_EXIT_CODE;
        });

        /**
         * @returns {Promise<string>}
         */
        async function fakeToolArgs() {
            return (await fs.promises.readFile(path.join(tmpDir, "fake-appimageupdatetool.args"), "utf-8")).trim();
        }

        it("reports an update when appimageupdatetool -j exits with 1", async function () {
            process.env.FAKE_EXIT_CODE = "1";

            const update = await createUpdater({ method: "zsync", appImageUpdateTool: fakeTool }).checkForUpdates();

            assert.deepStrictEqual(update, { updateAvailable: true });
            assert.strictEqual(await fakeToolArgs(), `-j ${appImagePath}`);
        });

        it("reports no update when appimageupdatetool -j exits with 0", async function () {
            const update = await createUpdater({ method: "zsync", appImageUpdateTool: fakeTool }).checkForUpdates();

            assert.deepStrictEqual(update, { updateAvailable: false });
        });

        it("throws when appimageupdatetool -j fails", async function () {
            process.env.FAKE_EXIT_CODE = "2";

            await assert.rejects(
                createUpdater({ method: "zsync", appImageUpdateTool: fakeTool }).checkForUpdates(),
                /failed with exit code 2/,
            );
        });

        it("updates the AppImage in place", async function () {
            const updater = createUpdater({ method: "zsync", appImageUpdateTool: fakeTool });

            const filePath = await updater.downloadUpdate({ updateAvailable: true });
            await updater.install(filePath);

            assert.strictEqual(filePath, appImagePath);
            assert.strictEqual(await fakeToolArgs(), `-O ${appImagePath}`);
        });

        it("throws a helpful error when appimageupdatetool is not installed", async function () {
            await assert.rejects(
                createUpdater({ method: "zsync", appImageUpdateTool: path.join(tmpDir, "missing-tool") }).checkForUpdates(),
                /Install AppImageUpdate's "appimageupdatetool"/,
            );
        });
    });
});
