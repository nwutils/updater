const path = await import("node:path");

import Updater from "./updater.js";

let updater;

function init() {
    updater = new Updater(nw.App.manifest, { temporaryDirectory: path.resolve(nw.App.dataPath, "tmpDir") });
    document.getElementById("check-for-updates-button").addEventListener("click", handleCheckForUpdates);
    document.getElementById("download-button").addEventListener("click", handleDownload);
}

/* Module scripts may finish evaluating after DOMContentLoaded has fired. */
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}

function handleCheckForUpdates() {
    const updateStatus = document.getElementById("update-status");
    updateStatus.textContent = "Checking for updates...";
    updater.checkNewVersion((err, newerVersionExists, remoteManifest) => {
        if (err) {
            updateStatus.textContent = `Error checking for updates: ${err.message}`;
            return;
        }
        if (newerVersionExists) {
            updateStatus.textContent = "A newer version is available.";
            document.getElementById("update-data").textContent = JSON.stringify(remoteManifest, null, 2);
        } else {
            updateStatus.textContent = "No new version available.";
        }
    });
}

function handleDownload() {
    const downloadStatus = document.getElementById("download-status");
    const newManifest = document.getElementById("update-data").textContent ? JSON.parse(document.getElementById("update-data").textContent) : null;
    downloadStatus.textContent = "Downloading update...";
    updater.download((err, filePath) => {
        if (err) {
            downloadStatus.textContent = `Error downloading update: ${err.message}`;
            return;
        }
        downloadStatus.textContent = "Update downloaded successfully at " + filePath;
        document.getElementById("download-data").textContent = filePath;
    }, newManifest);
}
