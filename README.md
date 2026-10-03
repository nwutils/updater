
# @nwutils/updater

[![npm](https://img.shields.io/npm/v/node-webkit-updater.svg?style=flat)](https://www.npmjs.com/package/node-webkit-updater)
[![Join the chat at https://gitter.im/nwjs/nwjs](https://badges.gitter.im/nwjs/nwjs.svg)](https://gitter.im/nwjs/nwjs)

Update NW.js applications. Linux is supported today; macOS and Windows support is planned.

## Getting Started

1. Install [Volta](https://volta.sh/).
1. `npm i @nwutils/updater`

The updater only uses Node.js built-in modules, imported as ES modules. Enable
NW.js' [ES module support](https://nwjs.io/blog/v0.98.2) in your app's
`package.json`:

```json
{
  "chromium-args": "--enable-features=NWESM,NWChainImportNode"
}
```

> In a module loaded by your page at startup, import Node.js built-ins
> dynamically, eg. `const fs = await import("node:fs")`; a static
> `import fs from "node:fs"` fails to load there. Since module scripts may
> finish evaluating after `DOMContentLoaded` has fired, check
> `document.readyState` before waiting for that event.

## Usage

Updating replaces the application's directory with the new version, in two
steps:

1. The running (old) version checks for, downloads and unpacks the new version
   into a temporary directory, starts it with the path to install itself to,
   and quits.
1. The new version, started from the temporary directory, copies itself over
   the old version, starts the installed copy and quits.

The same code runs in both versions, so tell them apart by their arguments:

```js
import Updater from "@nwutils/updater";

const updater = new Updater(nw.App.manifest);
const [command, installPath, installedExec] = nw.App.argv;

if (command === "--install-to") {
  /* Step 2: the new version, running from the temporary directory. */
  updater.install(installPath, (err) => {
    if (err) {
      console.error(err);
      return;
    }
    updater.run(installedExec, []);
    nw.App.quit();
  });
} else {
  /* Step 1: the installed (old) version. */
  updater.checkNewVersion((err, newerVersionExists, remoteManifest) => {
    if (err || !newerVersionExists) {
      return;
    }
    updater.download((err, filePath) => {
      if (err) {
        return;
      }
      updater.unpack(filePath, (err, newAppExec) => {
        if (err) {
          return;
        }
        updater.runInstaller(newAppExec, [
          "--install-to",
          updater.getAppPath(),
          updater.getAppExec(),
        ]);
        nw.App.quit();
      }, remoteManifest);
    }, remoteManifest);
  });
}
```

Packages are `.zip`, `.tar` or `.tar.gz` archives of the built application, with
its files at the root of the archive - as produced by `nw-builder` with
`zip: "zip"` or `zip: "tgz"`. The application's directory must be writable by
the user.

## Self updating AppImages

`AppImageUpdater` updates a Linux app packaged as an AppImage by
[`@nwutils/packager`](https://www.npmjs.com/package/@nwutils/packager) with
`publish` set. It follows electron-updater's approach: the packager embeds an
`app-update.yml` (where releases are published) in the AppImage and writes a
`latest-linux.yml` update info file (version, file name, size, SHA-512) next to
it. Upload both the AppImage and `latest-linux.yml` to every release.

```js
import { AppImageUpdater } from "@nwutils/updater";

const updater = new AppImageUpdater({ currentVersion: nw.App.manifest.version });

const update = await updater.checkForUpdates();
if (update.updateAvailable) {
  const filePath = await updater.downloadUpdate(update, {
    onProgress: ({ transferred, total }) => console.log(transferred, total),
  });
  await updater.install(filePath);
  updater.restart();
}
```

1. `checkForUpdates()` reads `app-update.yml` and downloads
   `latest-linux.yml` (`latest-linux-<arch>.yml` for architectures other than
   `x64`). For GitHub it uses
   `https://github.com/<owner>/<repo>/releases/latest/download/`, so no API
   token is needed. It then compares the published version with
   `currentVersion` using semantic versioning.
1. `downloadUpdate()` downloads the new AppImage to `temporaryDirectory` and
   checks its size and SHA-512 digest.
1. `install()` replaces the AppImage at `$APPIMAGE` atomically. The running app
   keeps working until it exits.
1. `restart()` starts the new AppImage and quits the app.

The AppImage's directory must be writable by the user.

### zsync

For users who prefer zsync, pass `method: "zsync"`. This uses
[AppImageUpdate](https://github.com/AppImageCommunity/AppImageUpdate)'s
`appimageupdatetool` and the update information embedded in the AppImage
(`updateInformation` in `@nwutils/packager`). Only the changed blocks are
downloaded. `appimageupdatetool` must be installed on the user's machine, and
it doesn't report the new version number.

```js
const updater = new AppImageUpdater({ method: "zsync" });

const update = await updater.checkForUpdates(); // appimageupdatetool -j
if (update.updateAvailable) {
  await updater.downloadUpdate(update); // appimageupdatetool -O: updates the AppImage in place
  updater.restart();
}
```

| Option             | Type                    | Default                                  | Description                                     |
| ------------------ | ----------------------- | ---------------------------------------- | ----------------------------------------------- |
| method             | `"manifest" \| "zsync"` | `"manifest"`                             | Update via `latest-linux.yml` or zsync          |
| currentVersion     | `string`                |                                          | Running app's version. Required by `"manifest"` |
| appImagePath       | `string`                | `process.env.APPIMAGE`                   | Path to the running AppImage                    |
| configPath         | `string`                | `app-update.yml` next to the executable  | Path to `app-update.yml`                        |
| temporaryDirectory | `string`                | `os.tmpdir()`                            | Directory updates are downloaded to             |
| appImageUpdateTool | `string`                | `"appimageupdatetool"`                   | `appimageupdatetool` executable for `"zsync"`   |

## API Schema

| Method | Arguments | Return Type | Description |
| ------ | --------- | ----------- | ----------- |
| new Updater | `manifest: object, options: object \| undefined` | `Updater` | Creates a new instance of Updater. See the [manifest schema](#manifest-schema) below. `options.temporaryDirectory` is where updates are downloaded to and unpacked in, defaulting to `os.tmpdir()`. |
| checkNewVersion | `cb: (error: Error, newerVersionExists: boolean, remoteManifest: object) => void` | `void` | Requests the manifest at `manifestUrl` and compares its `version` with the running version using semantic versioning. |
| download | `cb: (error: Error, filepath: string) => void, newManifest: object` | `void` | Downloads the package for the running platform listed in `newManifest` to the temporary directory. |
| unpack | `filename: string, cb: (error: Error, newAppExec: string) => void, manifest: object` | `void` | Extracts the downloaded package to `<temporaryDirectory>/<package name without extension>` and returns the path to the new version's executable. |
| runInstaller | `newAppExec: string, args: string[], options?: SpawnOptions` | `ChildProcess` | Starts the new version from the temporary directory with `args`. Pass `[updater.getAppPath(), updater.getAppExec()]` (plus any flag you use to recognise the install step) so it knows where to install itself, then quit. |
| install | `copyPath: string, cb: (error: Error) => void` | `void` | Run by the new version: replaces the application at `copyPath` with itself. Deleting the old version is retried for a few seconds while it quits. |
| run | `execPath: string, args?: string[], options?: SpawnOptions` | `ChildProcess` | Starts the installed application at `execPath`, then quit. |
| getAppPath | | `string` | Returns the running application's directory. |
| getAppExec | | `string` | Returns the running application's executable. |

## Manifest Schema

Example usage:

```json
{
    "name": "demo",
    "version": "0.0.1",
    "author": "NW.js Utils <contact@nwutils.io>",
    "manifestUrl": "http://localhost:3000/manifest.json",
    "packages": {
        "linux-x64": {
           "url": "http://localhost:3000/demo-0.0.1-linux-x64.zip"
        }
    }
}
```

> Note: The manifest could be a `package.json` of project, but doesn't have to be.

### manifest.name

The name of your app. The executable inside the package is assumed to be called `<manifest.name>`.

### manifest.version

[semver](http://semver.org) version of your app.

### manifest.manifestUrl

The URL where your latest manifest is hosted; where the updater looks to check if there is a newer version of your app available.

### manifest.packages

An object containing a package for each platform your app (at least this version of your app) supports, keyed by `<platform>-<arch>`, eg. `linux-x64` or `linux-arm64`.

### manifest.packages.\<platform\>-\<arch\>.url

Each package has to contain a `url` property pointing to where the app (for the version & platform in question) can be downloaded.

### manifest.packages.\<platform\>-\<arch\>.execPath (Optional)

It's assumed your app's executable is stored at the root of your package, named `manifest.name`. Use this to override that and specify a path relative to the root of your package.

## Contributing

### External contributor

- Use Node.js standard libraries whenever possible.
- Prefer to use syncronous APIs over modern APIs which have been introduced in later versions.

### Maintainer

- npm trusted publishing is used for releases
- a package is released when a maintainer creates a release note for a specific version
