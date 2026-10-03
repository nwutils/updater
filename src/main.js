const child_process = await import('node:child_process');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const process = await import('node:process');
const stream = await import('node:stream');

import util from './util.js';
import version from './version.js';

/**
 * @typedef {object} Platform
 * @property {string} url - The URL to the package
 * @property {string} execPath - The path to the executable
 */

/**
 * Packages keyed by `<platform>-<arch>`, eg. `linux-x64`.
 * @typedef {Record<string, Platform>} Packages
 */

/**
 * @typedef {object} Manifest
 * @property {string} name - The name of the application
 * @property {string} version - The current version of the application
 * @property {string} manifestUrl - The URL to the remote manifest file
 * @property {Packages} packages - The packages for the application
 */

/**
 * @typedef {object} UpdaterOptions
 * @property {string} temporaryDirectory - The path to a directory to download the updates to and unpack them in. Defaults to [`os.tmpdir()`](https://nodejs.org/api/os.html#os_os_tmpdir)
 */

/**
 * Key of the running platform in `manifest.packages`, eg. `linux-x64`.
 * @returns {string}
 */
function getHost() {
  let platform;

  switch (process.platform) {
    case 'win32':
      platform = 'windows';
      break;

    case 'darwin':
      platform = 'macos';
      break;

    case 'linux':
      platform = 'linux';
      break;

    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }

  const arch = process.arch;

  return `${platform}-${arch}`;

}

class Updater {

  /**
   * Creates new instance of Updater.
   * 
   * @constructor
   * @param {Manifest} manifest - See the [manifest schema](https://github.com/nwutils/updater?tab=readme-ov-file#manifest-schema).
   * @param {UpdaterOptions} options - Optional
   */
  constructor(manifest, options) {
    this.manifest = manifest;
    this.options = {
      temporaryDirectory: options && options.temporaryDirectory || os.tmpdir(),
    };
  }

  /**
  * Check the latest available version of the application by requesting the manifest specified in `manifestUrl`.
  *
  * @async
  * @method
  * @param {(error: Error|null, newerVersionExists: boolean, remoteManifest: object|null) => void} cb
  * @returns {void}
  */
  checkNewVersion(cb) {
    const currentVersion = this.manifest.version;

    fetch(this.manifest.manifestUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status}`);
        }
        return /** @type {Promise<Manifest>} */ (response.json());
      })
      .then((data) => {
        const latestVersion = data.version;

        cb(null, version.gt(latestVersion, currentVersion), data);
      })
      .catch((error) => {
        cb(error, false, null);
      });
  }

  /**
   * Downloads the new app to a temporary folder.
   *
   * @async
   * @method
   * @param {(error: Error|null, filepath: string|null) => void} cb
   * @param {Manifest} newManifest
   * @returns {void}
   */
  download(cb, newManifest) {
    const manifest = newManifest ?? this.manifest;
    const url = manifest.packages[getHost()].url;

    const filename = decodeURI(path.basename(url));

    fs.mkdirSync(this.options.temporaryDirectory, { recursive: true });
    const destinationPath = path.resolve(
      this.options.temporaryDirectory,
      filename
    );

    const writeStream = fs.createWriteStream(destinationPath);

    fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `Failed to download update: ${response.status} ${response.statusText}`
          );
        }

        if (!response.body) {
          throw new Error('Response body is not readable');
        }

        return stream.promises.pipeline(
          response.body,
          writeStream
        );
      })
      .then(() => {
        cb(null, destinationPath);
      })
      .catch((err) => {
        cb(err, null);
      });
  }

  /**
   * Returns the running application's path, ie. the directory containing
   * its executable.
   *
   * @returns {string}
   */
  getAppPath() {
    return path.dirname(process.execPath);
  }

  /**
   * Returns the running application's executable.
   *
   * @returns {string}
   */
  getAppExec() {
    return process.execPath;
  }

  /**
   * @private
   * @param {Manifest} manifest
   * @return {string}
   */
  getExecPathRelativeToPackage(manifest) {
    const execPath = manifest.packages[getHost()] && manifest.packages[getHost()].execPath;

    if (execPath) {
      return execPath;
    }
    else {
      return manifest.name;
    }
  };

  /**
   * Unpack the `filename` into its own directory in the temporary folder,
   * ie. `<temporaryDirectory>/<filename without extension>`.
   *
   * @param {string} filename
   * @param {(error: Error|null, newAppExec: string|null) => void} cb - Callback arguments: error, path to the new application's executable
   * @param {Manifest} manifest - The remote manifest describing the downloaded package.
   */
  unpack(filename, cb, manifest) {
    const destination = path.join(
      this.options.temporaryDirectory,
      path.basename(filename).replace(/(\.tar)?\.[^.]+$/, '')
    );

    fs.promises.rm(destination, { recursive: true, force: true })
      .then(() => fs.promises.mkdir(destination, { recursive: true }))
      .then(() => util.decompress(filename, destination))
      .then(() => {
        cb(null, path.join(destination, this.getExecPathRelativeToPackage(manifest)));
      })
      .catch((err) => {
        cb(err, null);
      });
  }

  /**
   * Runs the unpacked new application, passing `args` to it. Quit the
   * running application afterwards (eg. `nw.App.quit()`), so the new
   * application can replace it - see `install`.
   *
   * @param {string} newAppExec - Path returned by `unpack`.
   * @param {string[]} args - Arguments passed to the new application. Pass `[updater.getAppPath(), updater.getAppExec()]` so it knows where to install itself.
   * @param {import('node:child_process').SpawnOptions} [options] - See `spawn` from the Node.js docs.
   * @returns {import('node:child_process').ChildProcess}
   */
  runInstaller(newAppExec, args, options) {
    return spawnDetached(newAppExec, args, options);
  }

  /**
   * Installs the running application (ie. the new version started by
   * `runInstaller`) to `copyPath`, replacing the old version. Deleting is
   * retried for a few seconds, since the old version may still be quitting.
   *
   * @param {string} copyPath - Path of the old application, ie. the old version's `getAppPath()`.
   * @param {(error: Error|null) => void} cb - Callback arguments: error
   */
  install(copyPath, cb) {
    const appPath = this.getAppPath();
    if (path.resolve(appPath) === path.resolve(copyPath)) {
      cb(new Error(`Refusing to install ${appPath} over itself.`));
      return;
    }

    removeWithRetries(copyPath, 50, 100)
      .then(() => fs.promises.cp(appPath, copyPath, {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
      }))
      .then(() => {
        cb(null);
      })
      .catch((err) => {
        cb(err);
      });
  }

  /**
   * Runs the installed application. Quit the running (temporary) application
   * afterwards.
   *
   * @param {string} execPath - Path of the installed application's executable, ie. the old version's `getAppExec()`.
   * @param {string[]} [args] - Arguments passed to the application.
   * @param {import('node:child_process').SpawnOptions} [options] - See `spawn` from the Node.js docs.
   * @returns {import('node:child_process').ChildProcess}
   */
  run(execPath, args, options) {
    return spawnDetached(execPath, args ?? [], options);
  }
}

/**
 * Start the application at `execPath` without tying its lifetime to the
 * running process.
 *
 * @param {string} execPath
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [options]
 * @returns {import('node:child_process').ChildProcess}
 */
function spawnDetached(execPath, args, options) {
  /* Archives don't always preserve the executable bit. */
  fs.chmodSync(execPath, 0o755);
  const child = child_process.spawn(execPath, args, {
    cwd: path.dirname(execPath),
    detached: true,
    stdio: 'ignore',
    ...options,
  });
  child.unref();
  return child;
}

/**
 * Remove `dirPath`, retrying while files are still in use.
 *
 * @param {string} dirPath
 * @param {number} attempts
 * @param {number} delay - Milliseconds between attempts.
 * @returns {Promise<void>}
 */
async function removeWithRetries(dirPath, attempts, delay) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= attempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export default Updater;
export { default as AppImageUpdater } from './appImage.js';
