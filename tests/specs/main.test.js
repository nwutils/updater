import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { after, before, describe, it } from "node:test";

import express from "express";
import nwbuild from "nw-builder";
import selenium from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

/* Pinned so the fixture apps and chromedriver come from the same NW.js release. */
const NW_VERSION = "0.111.1";

describe("updater test suite", function () {
    /* Setup updater staging server. */
    const app = express();
    const filesDir = path.join(process.cwd(), "tests", "fixtures", "releases");
    app.use("/", express.static(filesDir));
    const server = http.createServer(app);

    /* Setup Selenium WebDriver with NW.js */
    let driver = undefined;
    const options = new chrome.Options();
    const seleniumArguments = [
        "nwapp=" + path.resolve("tests", "fixtures", "app-current"),
        "user-data-dir=" + path.resolve("tests", "fixtures", "nwjs-user-data"),
    ];
    seleniumArguments.push("headless=new");
    options.addArguments(seleniumArguments);
    const chromeDriverPath = path.resolve("cache", `nwjs-sdk-v${NW_VERSION}-linux-x64`, "chromedriver");
    const service = new chrome.ServiceBuilder(chromeDriverPath).build();

    before(async function () {
        fs.copyFileSync("./src/main.js", "./tests/fixtures/app-current/updater.js");
        /* Modules imported by main.js. */
        fs.copyFileSync("./src/util.js", "./tests/fixtures/app-current/util.js");
        fs.copyFileSync("./src/appImage.js", "./tests/fixtures/app-current/appImage.js");
        fs.copyFileSync("./src/version.js", "./tests/fixtures/app-current/version.js");

        /* Build NW.js applications for testing. */
        let nwOptions = {
            mode: "build",
            version: NW_VERSION,
            flavor: "sdk",
            platform: "linux",
            arch: "x64",
            glob: false,
        };
        nwOptions = {
            ...nwOptions,
            srcDir: "./tests/fixtures/app-current",
            outDir: "./tests/fixtures/releases/app-0.0.1-linux-x64"
        };
        if (!fs.existsSync(nwOptions.outDir)) {
            await nwbuild(nwOptions);
        }

        fs.cpSync("./tests/fixtures/app-current", "./tests/fixtures/app-latest", { recursive: true });
        const latestPackageJsonPath = path.join(process.cwd(), "tests", "fixtures", "app-latest", "package.json");
        const latestPackageJson = JSON.parse(fs.readFileSync(latestPackageJsonPath, "utf-8"));
        latestPackageJson.version = "0.0.2";
        fs.writeFileSync(latestPackageJsonPath, JSON.stringify(latestPackageJson, null, 2), "utf-8");
        nwOptions = {
            ...nwOptions,
            srcDir: "./tests/fixtures/app-latest",
            outDir: "./tests/fixtures/releases/app-0.0.2-linux-x64",
            zip: "zip",
        };
        if (!fs.existsSync(`${nwOptions.outDir}.zip`)) {
            await nwbuild(nwOptions);
        }

        /* Start Selenium WebDriver session after building NW.js test applications. */
        driver = chrome.Driver.createSession(options, service);

        await new Promise((resolve) => {
            server.listen(3000, resolve);
        });
    });

    it("runs the current application and checks for updates", async function () {
        const statusLocator = selenium.By.id("update-status");
        const initialText = await driver.findElement(statusLocator).getText();
        assert.strictEqual(initialText, "");

        const button = await driver.findElement(selenium.By.id("check-for-updates-button"));
        await button.click();

        /* checkNewVersion is asynchronous: wait for it to report a result. */
        await driver.wait(async () => {
            const text = await driver.findElement(statusLocator).getText();
            return text !== "" && text !== "Checking for updates...";
        }, 10000);
        const finalText = await driver.findElement(statusLocator).getText();
        assert.strictEqual(finalText, "A newer version is available.");
    });

    it("runs the application and downloads the update", async function () {
        const downloadLocator = selenium.By.id("download-status");
        const initialText = await driver.findElement(downloadLocator).getText();
        assert.strictEqual(initialText, "");

        const button = await driver.findElement(selenium.By.id("download-button"));
        await button.click();
        await driver.sleep(5000);

        const finalText = await driver.findElement(downloadLocator).getText();
        assert.ok(finalText.startsWith("Update downloaded successfully"), "Expected download success message.");

        const downloadFilePath = await driver.findElement(selenium.By.id("download-data")).getText();
        assert.strictEqual(downloadFilePath, path.resolve(process.cwd(), "tests", "fixtures", "nwjs-user-data", "Default", "tmpDir", "app-0.0.2-linux-x64.zip"));
    });

    after(async function () {
        await new Promise((resolve, reject) => {
            server.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        await driver.quit();
    });
});
