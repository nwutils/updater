
const child_process = await import('node:child_process');
const fs = await import('node:fs');
const path = await import('node:path');
const stream = await import('node:stream');
const zlib = await import('node:zlib');

/*
 * Only Node.js built-in modules are used here: NW.js can't resolve bare
 * package imports from the application's browser context.
 */

/**
 * Decompresses a file at `filePath` to `cacheDir` directory.
 * @async
 * @function
 * @param {string} filePath  - file path to compressed binary
 * @param {string} cacheDir  - directory to decompress into
 * @throws {Error}
 * @returns {Promise<void>}
 */
async function decompress(filePath, cacheDir) {
    if (filePath.endsWith('.zip')) {
        await unzip(filePath, cacheDir);
    } else {
        await untar(filePath, cacheDir);
    }
}

/**
 * Extract a `.tar`, `.tar.gz` or `.tgz` archive with the system `tar`, which
 * detects the compression itself and refuses to write outside `cacheDir`.
 * @param {string} tarFile  - file path to the archive
 * @param {string} cacheDir - directory to extract into
 * @returns {Promise<void>}
 */
function untar(tarFile, cacheDir) {
    return new Promise((resolve, reject) => {
        child_process.execFile('tar', ['-xf', tarFile, '-C', cacheDir], (error, _stdout, stderr) => {
            if (error) {
                reject(new Error(`Unable to extract ${tarFile}: ${stderr || error.message}`, { cause: error }));
            } else {
                resolve();
            }
        });
    });
}

/**
 * @typedef {object} ZipEntry
 * @property {string} fileName
 * @property {number} method           - 0 (stored) or 8 (deflated)
 * @property {number} compressedSize
 * @property {number} localHeaderOffset
 * @property {number} mode             - Unix mode, 0 if the archive wasn't created on Unix
 */

/**
 * Read `length` bytes at `position` from `fileHandle`.
 * @param {import('node:fs/promises').FileHandle} fileHandle
 * @param {number} length
 * @param {number} position
 * @returns {Promise<Buffer>}
 */
async function readAt(fileHandle, length, position) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
}

/**
 * Read the central directory of the zip archive open as `fileHandle`.
 * @param {import('node:fs/promises').FileHandle} fileHandle
 * @returns {Promise<ZipEntry[]>}
 */
async function readZipEntries(fileHandle) {
    const { size } = await fileHandle.stat();
    /* The end of central directory record is 22 bytes, followed by a comment of up to 65535 bytes. */
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fileHandle, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) {
        throw new Error('Not a zip archive: end of central directory not found.');
    }

    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
        throw new Error('ZIP64 archives are not supported. Use a .tar.gz archive instead.');
    }

    const directory = await readAt(fileHandle, directorySize, directoryOffset);
    /** @type {ZipEntry[]} */
    const entries = [];
    let offset = 0;
    for (let i = 0; i < entryCount; i++) {
        if (directory.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('Corrupt zip archive: invalid central directory entry.');
        }
        const madeBy = directory.readUInt16LE(offset + 4) >> 8;
        const method = directory.readUInt16LE(offset + 10);
        const compressedSize = directory.readUInt32LE(offset + 20);
        const fileNameLength = directory.readUInt16LE(offset + 28);
        const extraLength = directory.readUInt16LE(offset + 30);
        const commentLength = directory.readUInt16LE(offset + 32);
        const externalAttributes = directory.readUInt32LE(offset + 38);
        const localHeaderOffset = directory.readUInt32LE(offset + 42);
        const fileName = directory.toString('utf8', offset + 46, offset + 46 + fileNameLength);

        if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
            throw new Error('ZIP64 archives are not supported. Use a .tar.gz archive instead.');
        }

        entries.push({
            fileName,
            method,
            compressedSize,
            localHeaderOffset,
            /* 3 is Unix, which stores the file mode in the upper 16 bits. */
            mode: madeBy === 3 ? externalAttributes >>> 16 : 0,
        });
        offset += 46 + fileNameLength + extraLength + commentLength;
    }
    return entries;
}

/**
 * Stream the (decompressed) contents of `entry`.
 * @param {string} zippedFile
 * @param {import('node:fs/promises').FileHandle} fileHandle
 * @param {ZipEntry} entry
 * @returns {Promise<import('node:stream').Readable>}
 */
async function openEntryStream(zippedFile, fileHandle, entry) {
    const localHeader = await readAt(fileHandle, 30, entry.localHeaderOffset);
    if (localHeader.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`Corrupt zip archive: invalid local header for ${entry.fileName}.`);
    }
    const dataOffset = entry.localHeaderOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);

    if (entry.compressedSize === 0) {
        return stream.Readable.from([]);
    }
    const raw = fs.createReadStream(zippedFile, { start: dataOffset, end: dataOffset + entry.compressedSize - 1 });
    if (entry.method === 0) {
        return raw;
    }
    if (entry.method === 8) {
        return raw.pipe(zlib.createInflateRaw());
    }
    raw.destroy();
    throw new Error(`Unsupported compression method ${entry.method} for ${entry.fileName}.`);
}

/**
 * Unzip `zippedFile` to `cacheDir`, preserving Unix file modes and symbolic links.
 * @async
 * @function
 * @param  {string}        zippedFile  - file path to .zip file
 * @param  {string}        cacheDir    - directory to unzip in
 * @throws {Error}
 * @returns {Promise<void>}
 */
async function unzip(zippedFile, cacheDir) {
    const root = path.resolve(cacheDir);
    const fileHandle = await fs.promises.open(zippedFile, 'r');
    try {
        const entries = await readZipEntries(fileHandle);
        /** @type {{entryPathAbs: string, linkTarget: string}[]} */
        const symlinks = [];

        for (const entry of entries) {
            const entryPathAbs = path.resolve(root, entry.fileName);
            if (entryPathAbs !== root && !entryPathAbs.startsWith(root + path.sep)) {
                throw new Error(`Refusing to extract ${entry.fileName} outside of ${cacheDir}.`);
            }

            if (entry.fileName.endsWith('/')) {
                await fs.promises.mkdir(entryPathAbs, { recursive: true });
                continue;
            }
            await fs.promises.mkdir(path.dirname(entryPathAbs), { recursive: true });

            const entryStream = await openEntryStream(zippedFile, fileHandle, entry);
            if ((entry.mode & 0o170000) === 0o120000) {
                /* Create symbolic links last, so none can redirect a later entry outside of cacheDir. */
                /** @type {Buffer[]} */
                const chunks = [];
                for await (const chunk of entryStream) {
                    chunks.push(chunk);
                }
                symlinks.push({ entryPathAbs, linkTarget: Buffer.concat(chunks).toString('utf8') });
                continue;
            }

            await fs.promises.rm(entryPathAbs, { force: true });
            await stream.promises.pipeline(entryStream, fs.createWriteStream(entryPathAbs));
            await fs.promises.chmod(entryPathAbs, entry.mode & 0o7777 || 0o644);
        }

        for (const { entryPathAbs, linkTarget } of symlinks) {
            await fs.promises.rm(entryPathAbs, { force: true });
            await fs.promises.symlink(linkTarget, entryPathAbs);
        }
    } finally {
        await fileHandle.close();
    }
}

export default { decompress };
