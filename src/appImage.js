const child_process = await import('node:child_process');
const crypto = await import('node:crypto');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const process = await import('node:process');

import semver from './version.js';

/**
 * Contents of the `app-update.yml` file `@nwutils/packager` embeds next to the
 * NW.js executable inside the AppImage.
 * @typedef {{provider: 'github', owner: string, repo: string} | {provider: 'generic', url: string}} PublishConfig
 */

/**
 * @typedef {object} AppImageUpdaterOptions
 * @property {'manifest' | 'zsync'} [method='manifest'] - `'manifest'` uses the `latest-linux.yml` update info file published next to the AppImage, the same way electron-updater does. `'zsync'` delegates to `appimageupdatetool` and the update information embedded in the AppImage.
 * @property {string} [currentVersion] - Version of the running application, eg. `nw.App.manifest.version`. Required by the `'manifest'` method.
 * @property {string} [appImagePath] - Path to the running AppImage. Defaults to the `APPIMAGE` environment variable the AppImage runtime sets.
 * @property {string} [configPath] - Path to `app-update.yml`. Defaults to the file next to the NW.js executable.
 * @property {string} [temporaryDirectory] - Directory updates are downloaded to. Defaults to [`os.tmpdir()`](https://nodejs.org/api/os.html#os_os_tmpdir).
 * @property {string} [appImageUpdateTool='appimageupdatetool'] - `appimageupdatetool` executable used by the `'zsync'` method.
 */

/**
 * @typedef {object} UpdateCheckResult
 * @property {boolean} updateAvailable - True if a newer version is published.
 * @property {string} [version] - Latest published version. Not known to the `'zsync'` method.
 * @property {string} [url] - URL the new AppImage is downloaded from.
 * @property {string} [sha512] - Base64 encoded SHA-512 digest of the new AppImage.
 * @property {number} [size] - Size of the new AppImage in bytes.
 * @property {string} [releaseDate] - When the latest version was published.
 */

/**
 * @typedef {object} DownloadProgress
 * @property {number} transferred - Bytes downloaded so far.
 * @property {number | undefined} total - Total bytes, if known.
 */

/**
 * Parse a YAML scalar as written by `@nwutils/packager` or electron-builder.
 * @param {string} value
 * @returns {string | number | boolean}
 */
function parseYamlScalar(value) {
  if (value.startsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith('\'') && value.endsWith('\'') && value.length >= 2) {
    return value.slice(1, -1).replaceAll('\'\'', '\'');
  }
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

/**
 * Parse the subset of YAML update info and `app-update.yml` files use: a map
 * of scalars, and lists of maps of scalars. This covers files written by
 * `@nwutils/packager` and electron-builder without pulling in a YAML library.
 * @param {string} contents
 * @returns {Record<string, string | number | boolean | Record<string, string | number | boolean>[]>}
 */
function parseYaml(contents) {
  /** @type {Record<string, string | number | boolean | Record<string, string | number | boolean>[]>} */
  const entries = {};
  /** @type {Record<string, string | number | boolean>[] | undefined} */
  let currentList;
  /** @type {Record<string, string | number | boolean> | undefined} */
  let currentItem;

  for (const rawLine of contents.split('\n')) {
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) {
      continue;
    }

    const isListItem = /^\s+- /.test(rawLine);
    const isIndented = /^\s/.test(rawLine);
    const line = rawLine.trim().replace(/^- /, '');
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      throw new Error(`Unable to parse YAML line: ${rawLine}`);
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (isIndented === false) {
      currentItem = undefined;
      if (value === '') {
        currentList = [];
        entries[key] = currentList;
      } else {
        currentList = undefined;
        entries[key] = parseYamlScalar(value);
      }
      continue;
    }

    if (currentList === undefined) {
      throw new Error(`Unable to parse YAML line: ${rawLine}`);
    }
    if (isListItem || currentItem === undefined) {
      currentItem = {};
      currentList.push(currentItem);
    }
    currentItem[key] = parseYamlScalar(value);
  }

  return entries;
}

/**
 * Name of the update info file for `arch`, matching `@nwutils/packager` and
 * electron-builder: `x64` gets the bare `latest-linux.yml`, every other
 * architecture gets an `-<arch>` suffix.
 * @param {string} arch
 * @returns {string}
 */
function updateInfoFileName(arch) {
  return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`;
}

/**
 * Base URL the latest release's files are downloaded from.
 * @param {PublishConfig} config
 * @returns {string} Always ends with a `/`, so relative file names resolve against it.
 */
function getReleaseBaseUrl(config) {
  if (config.provider === 'github') {
    /*
     * GitHub redirects this to the matching asset of the latest non draft,
     * non prerelease release - no API call (or token, or rate limit) needed.
     */
    return `https://github.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/releases/latest/download/`;
  }
  return `${config.url.replace(/\/+$/, '')}/`;
}

/**
 * Throw if `config` isn't a valid `PublishConfig`.
 * @param {Record<string, unknown>} config
 * @returns {asserts config is PublishConfig}
 */
function validatePublishConfig(config) {
  /** @type {string[]} */
  let requiredKeys;
  if (config.provider === 'github') {
    requiredKeys = ['owner', 'repo'];
  } else if (config.provider === 'generic') {
    requiredKeys = ['url'];
  } else {
    throw new Error(`Expected "provider" in app-update.yml to be "github" or "generic". Received: ${JSON.stringify(config.provider)}`);
  }
  for (const key of requiredKeys) {
    if (typeof config[key] !== 'string' || config[key] === '') {
      throw new Error(`Expected "${key}" in app-update.yml to be a non-empty string for provider "${config.provider}".`);
    }
  }
}

/**
 * Run `file` with `args`, resolving with its exit code.
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<number>}
 */
function execExitCode(file, args) {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(file, args, { stdio: 'ignore' });
    child.on('error', (error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        reject(new Error(`"${file}" was not found. Install AppImageUpdate's "appimageupdatetool" to use the "zsync" update method.`));
      } else {
        reject(error);
      }
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Self updates a NW.js application packaged as an AppImage by
 * `@nwutils/packager` with `publish` set.
 */
class AppImageUpdater {

  /**
   * @param {AppImageUpdaterOptions} [options]
   */
  constructor(options = {}) {
    if (options.method !== undefined && options.method !== 'manifest' && options.method !== 'zsync') {
      throw new Error(`Expected "options.method" to be "manifest" or "zsync". Received: ${JSON.stringify(options.method)}`);
    }
    this.options = {
      method: options.method ?? 'manifest',
      currentVersion: options.currentVersion,
      appImagePath: options.appImagePath ?? process.env.APPIMAGE,
      configPath: options.configPath ?? path.join(path.dirname(process.execPath), 'app-update.yml'),
      temporaryDirectory: options.temporaryDirectory ?? os.tmpdir(),
      appImageUpdateTool: options.appImageUpdateTool ?? 'appimageupdatetool',
    };
  }

  /**
   * Path to the running AppImage.
   * @private
   * @returns {string}
   */
  getAppImagePath() {
    if (this.options.appImagePath === undefined || this.options.appImagePath === '') {
      throw new Error('The application is not running from an AppImage: the "APPIMAGE" environment variable is not set.');
    }
    return this.options.appImagePath;
  }

  /**
   * Read `app-update.yml`.
   * @private
   * @returns {Promise<PublishConfig>}
   */
  async getPublishConfig() {
    let contents;
    try {
      contents = await fs.promises.readFile(this.options.configPath, 'utf-8');
    } catch (error) {
      throw new Error(`Unable to read ${this.options.configPath}. Was the AppImage packaged with "publish" set?`, { cause: error });
    }
    const config = parseYaml(contents);
    validatePublishConfig(config);
    return config;
  }

  /**
   * Check whether a newer version is published.
   *
   * With the `'manifest'` method this downloads the `latest-linux.yml` update
   * info file for the running architecture and compares its version with
   * `currentVersion` using semantic versioning. With the `'zsync'` method it
   * runs `appimageupdatetool --check-for-update`.
   * @returns {Promise<UpdateCheckResult>}
   */
  async checkForUpdates() {
    const appImagePath = this.getAppImagePath();

    if (this.options.method === 'zsync') {
      const exitCode = await execExitCode(this.options.appImageUpdateTool, ['-j', appImagePath]);
      if (exitCode !== 0 && exitCode !== 1) {
        throw new Error(`"${this.options.appImageUpdateTool} -j" failed with exit code ${exitCode}. Does the AppImage embed update information?`);
      }
      /* `-j` exits with 1 when an update is available, 0 when it isn't. */
      return { updateAvailable: exitCode === 1 };
    }

    const currentVersion = this.options.currentVersion;
    if (!semver.valid(currentVersion)) {
      throw new Error(`Expected "options.currentVersion" to be a valid semantic version. Received: ${JSON.stringify(currentVersion)}`);
    }

    const baseUrl = getReleaseBaseUrl(await this.getPublishConfig());
    const updateInfoUrl = new URL(updateInfoFileName(process.arch), baseUrl).href;

    const response = await fetch(updateInfoUrl);
    if (!response.ok) {
      throw new Error(`Unable to download ${updateInfoUrl}: ${response.status} ${response.statusText}`);
    }
    const updateInfo = parseYaml(await response.text());

    const version = updateInfo.version;
    if (typeof version !== 'string' || !semver.valid(version)) {
      throw new Error(`Expected "version" in ${updateInfoUrl} to be a valid semantic version. Received: ${JSON.stringify(version)}`);
    }

    /** @type {Record<string, unknown>} */
    const file = Array.isArray(updateInfo.files) && updateInfo.files.length > 0
      ? updateInfo.files[0]
      : { url: updateInfo.path, sha512: updateInfo.sha512 };
    if (typeof file.url !== 'string' || typeof file.sha512 !== 'string') {
      throw new Error(`Expected ${updateInfoUrl} to list the AppImage's "url" and "sha512".`);
    }

    return {
      updateAvailable: semver.gt(version, /** @type {string} */ (currentVersion)),
      version,
      /* Relative to the update info file, ie. an asset of the same release. */
      url: new URL(file.url, baseUrl).href,
      sha512: file.sha512,
      size: typeof file.size === 'number' ? file.size : undefined,
      releaseDate: typeof updateInfo.releaseDate === 'string' ? updateInfo.releaseDate : undefined,
    };
  }

  /**
   * Download the update found by `checkForUpdates`.
   *
   * With the `'manifest'` method the new AppImage is downloaded to
   * `temporaryDirectory` and verified against the published size and SHA-512
   * digest - pass the returned path to `install`. With the `'zsync'` method
   * `appimageupdatetool` downloads only the changed blocks and replaces the
   * running AppImage in place, so the returned path is the AppImage itself and
   * `install` has nothing left to do.
   * @param {UpdateCheckResult} update
   * @param {{onProgress?: (progress: DownloadProgress) => void}} [options]
   * @returns {Promise<string>} Path to the downloaded AppImage.
   */
  async downloadUpdate(update, options = {}) {
    const appImagePath = this.getAppImagePath();

    if (this.options.method === 'zsync') {
      const exitCode = await execExitCode(this.options.appImageUpdateTool, ['-O', appImagePath]);
      if (exitCode !== 0) {
        throw new Error(`"${this.options.appImageUpdateTool}" failed with exit code ${exitCode}.`);
      }
      return appImagePath;
    }

    if (update.url === undefined || update.sha512 === undefined) {
      throw new Error('Expected the result of "checkForUpdates()" with a "url" and "sha512".');
    }

    await fs.promises.mkdir(this.options.temporaryDirectory, { recursive: true });
    const destinationPath = path.join(
      this.options.temporaryDirectory,
      `${path.basename(appImagePath)}.${update.version ?? 'update'}.download`,
    );

    const response = await fetch(update.url);
    if (!response.ok || response.body === null) {
      throw new Error(`Unable to download ${update.url}: ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    const total = update.size ?? (contentLength > 0 ? contentLength : undefined);

    const hash = crypto.createHash('sha512');
    const fileHandle = await fs.promises.open(destinationPath, 'w', 0o755);
    let transferred = 0;
    try {
      for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (response.body))) {
        hash.update(chunk);
        await fileHandle.write(chunk);
        transferred += chunk.byteLength;
        options.onProgress?.({ transferred, total });
      }
    } catch (error) {
      await fileHandle.close();
      await fs.promises.rm(destinationPath, { force: true });
      throw error;
    }
    await fileHandle.close();

    const digest = hash.digest('base64');
    if ((update.size !== undefined && transferred !== update.size) || digest !== update.sha512) {
      await fs.promises.rm(destinationPath, { force: true });
      throw new Error(`The AppImage downloaded from ${update.url} does not match the published size and SHA-512 digest.`);
    }

    return destinationPath;
  }

  /**
   * Replace the running AppImage with the one at `filePath`. The running
   * process keeps working from the old, already mounted image until it
   * exits - call `restart` to switch to the new version.
   * @param {string} filePath - Path returned by `downloadUpdate`.
   * @returns {Promise<void>}
   */
  async install(filePath) {
    const appImagePath = this.getAppImagePath();
    if (path.resolve(filePath) === path.resolve(appImagePath)) {
      return;
    }

    /*
     * Copy next to the AppImage first, then rename over it: a rename within
     * a directory is atomic, so the AppImage is never left half written, and
     * works even though the old file is still in use.
     */
    const stagingPath = path.join(
      path.dirname(appImagePath),
      `.${path.basename(appImagePath)}.update-${process.pid}`,
    );
    try {
      await fs.promises.copyFile(filePath, stagingPath);
      await fs.promises.chmod(stagingPath, 0o755);
      await fs.promises.rename(stagingPath, appImagePath);
    } catch (error) {
      await fs.promises.rm(stagingPath, { force: true });
      throw new Error(`Unable to replace ${appImagePath}. Is its directory writable?`, { cause: error });
    }
    await fs.promises.rm(filePath, { force: true });
  }

  /**
   * Start the (updated) AppImage and quit the running application.
   * @param {string[]} [args] - Arguments passed to the new process.
   * @returns {void}
   */
  restart(args = []) {
    const child = child_process.spawn(this.getAppImagePath(), args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    const nwApp = /** @type {{nw?: {App?: {quit?: () => void}}}} */ (globalThis).nw?.App;
    if (typeof nwApp?.quit === 'function') {
      nwApp.quit();
    } else {
      process.exit(0);
    }
  }
}

export default AppImageUpdater;
export { parseYaml, updateInfoFileName };
