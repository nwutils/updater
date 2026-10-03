import assert from "node:assert/strict";
import child_process from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, beforeEach, describe, it } from "node:test";

import Updater from "../../src/main.js";

/*
 * Exercises the Linux update flow without NW.js: check -> download -> unpack
 * -> runInstaller (old version) -> install -> run (new version).
 */
describe("Updater on Linux", { skip: process.platform !== "linux" }, function () {
    const host = `linux-${process.arch}`;
    const hasZip = child_process.spawnSync("zip", ["-v"]).status === 0;

    let tmpDir = "";
    let releasesDir = "";
    let baseUrl = "";
    const server = http.createServer((req, res) => {
        const filePath = path.join(releasesDir, decodeURIComponent(/** @type {string} */ (req.url)));
        if (!fs.existsSync(filePath)) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200);
        fs.createReadStream(filePath).pipe(res);
    });

    /**
     * Write a fake "NW.js app" whose executable records its arguments.
     * @param {string} appDir
     * @param {string} version
     */
    async function writeApp(appDir, version) {
        await fs.promises.mkdir(path.join(appDir, "lib"), { recursive: true });
        await fs.promises.writeFile(
            path.join(appDir, "demo"),
            `#!/bin/sh\necho "${version} $@" > "${path.join(tmpDir, "ran")}"\n`,
            { mode: 0o755 },
        );
        await fs.promises.writeFile(path.join(appDir, "lib", "libnw.so"), `libnw ${version}`);
        await fs.promises.symlink("libnw.so", path.join(appDir, "lib", "libnw.so.1"));
    }

    /**
     * Wait until the fake app's executable has run and return what it logged.
     * @returns {Promise<string>}
     */
    async function waitForRun() {
        const ranPath = path.join(tmpDir, "ran");
        for (let attempt = 0; attempt < 100; attempt++) {
            if (fs.existsSync(ranPath)) {
                const contents = (await fs.promises.readFile(ranPath, "utf-8")).trim();
                if (contents !== "") {
                    return contents;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("The application was not started.");
    }

    /**
     * @param {string} archiveName
     * @returns {import("../../src/main.js").Manifest}
     */
    function remoteManifest(archiveName) {
        return {
            name: "demo",
            version: "0.0.2",
            manifestUrl: `${baseUrl}/manifest.json`,
            packages: { [host]: { url: `${baseUrl}/${archiveName}`, execPath: "" } },
        };
    }

    before(async function () {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nwutils-updater-linux-test-"));
        releasesDir = path.join(tmpDir, "releases");

        await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
        baseUrl = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;

        /* Package the new version the way nw-builder does: files at the archive's root. */
        const newAppDir = path.join(tmpDir, "build-0.0.2");
        await writeApp(newAppDir, "0.0.2");
        await fs.promises.mkdir(releasesDir, { recursive: true });
        child_process.execFileSync("tar", ["-czf", path.join(releasesDir, "demo-0.0.2-linux.tar.gz"), "."], { cwd: newAppDir });
        if (hasZip) {
            child_process.execFileSync("zip", ["-q", "-r", "-y", path.join(releasesDir, "demo-0.0.2-linux.zip"), "."], { cwd: newAppDir });
        }
        await fs.promises.writeFile(path.join(releasesDir, "manifest.json"), JSON.stringify(remoteManifest("demo-0.0.2-linux.tar.gz")));
    });

    beforeEach(async function () {
        await fs.promises.rm(path.join(tmpDir, "ran"), { force: true });
    });

    after(async function () {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    it("locates the running application from its executable", function () {
        const updater = new Updater(remoteManifest(""));

        assert.strictEqual(updater.getAppPath(), path.dirname(process.execPath));
        assert.strictEqual(updater.getAppExec(), process.execPath);
    });

    it("finds a newer version, including pre-releases", async function () {
        for (const [currentVersion, expected] of [["0.0.1", true], ["0.0.2", false], ["0.0.2-beta.1", true]]) {
            const updater = new Updater({ ...remoteManifest(""), version: /** @type {string} */ (currentVersion) });

            const newerVersionExists = await new Promise((resolve, reject) => {
                updater.checkNewVersion((err, newer) => (err ? reject(err) : resolve(newer)));
            });

            assert.strictEqual(newerVersionExists, expected, `current version ${currentVersion}`);
        }
    });

    for (const archiveName of ["demo-0.0.2-linux.tar.gz", "demo-0.0.2-linux.zip"]) {
        it(`downloads, unpacks, installs and runs an update from ${archiveName}`, { skip: archiveName.endsWith(".zip") && !hasZip }, async function () {
            const temporaryDirectory = path.join(tmpDir, `tmp-${archiveName}`);
            const installedAppDir = path.join(tmpDir, `installed-${archiveName}`);
            await writeApp(installedAppDir, "0.0.1");
            await fs.promises.writeFile(path.join(installedAppDir, "stale-0.0.1-only"), "");
            const manifest = remoteManifest(archiveName);

            /* Old version: download and unpack, then hand over to the new version. */
            const oldVersion = new Updater({ ...manifest, version: "0.0.1" }, { temporaryDirectory });
            const filePath = await new Promise((resolve, reject) => {
                oldVersion.download((err, downloaded) => (err ? reject(err) : resolve(downloaded)), manifest);
            });
            const newAppExec = await new Promise((resolve, reject) => {
                oldVersion.unpack(/** @type {string} */ (filePath), (err, exec) => (err ? reject(err) : resolve(exec)), manifest);
            });
            assert.strictEqual(newAppExec, path.join(temporaryDirectory, archiveName.replace(/(\.tar)?\.[^.]+$/, ""), "demo"));

            const installedAppExec = path.join(installedAppDir, "demo");
            oldVersion.runInstaller(/** @type {string} */ (newAppExec), [installedAppDir, installedAppExec]);
            assert.strictEqual(await waitForRun(), `0.0.2 ${installedAppDir} ${installedAppExec}`);

            /* New version, started from the temporary directory: install over the old one and relaunch. */
            const newVersion = new Updater(manifest, { temporaryDirectory });
            newVersion.getAppPath = () => path.dirname(/** @type {string} */ (newAppExec));
            await new Promise((resolve, reject) => {
                newVersion.install(installedAppDir, (err) => (err ? reject(err) : resolve(undefined)));
            });

            assert.strictEqual(fs.existsSync(path.join(installedAppDir, "stale-0.0.1-only")), false, "files of the old version are removed");
            assert.strictEqual(await fs.promises.readFile(path.join(installedAppDir, "lib", "libnw.so"), "utf-8"), "libnw 0.0.2");
            assert.strictEqual(await fs.promises.readlink(path.join(installedAppDir, "lib", "libnw.so.1")), "libnw.so");

            await fs.promises.rm(path.join(tmpDir, "ran"));
            newVersion.run(installedAppExec, ["--updated"]);
            assert.strictEqual(await waitForRun(), "0.0.2 --updated");
        });
    }

    it("refuses to install an application over itself", async function () {
        const updater = new Updater(remoteManifest(""));

        await assert.rejects(
            new Promise((resolve, reject) => {
                updater.install(updater.getAppPath(), (err) => (err ? reject(err) : resolve(undefined)));
            }),
            /Refusing to install .* over itself/,
        );
    });
});
