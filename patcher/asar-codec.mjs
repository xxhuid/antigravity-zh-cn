/**
 * Pure Node.js ASAR Reader / Rewriter (Zero external dependencies)
 * - Preserves all `unpacked: true` entries, symlinks (`link`), `executable` flags, and original file bytes verbatim
 * - Never reads or modifies sibling `app.asar.unpacked` directories
 * - Recomputes standard Electron SHA-256 block integrity metadata for modified/added files
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024; // 4 MiB (Electron ASAR default)

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function computeAsarIntegrity(buf) {
  const blocks = [];
  if (buf.length === 0) {
    blocks.push(sha256Hex(buf));
  } else {
    for (let offset = 0; offset < buf.length; offset += INTEGRITY_BLOCK_SIZE) {
      blocks.push(sha256Hex(buf.subarray(offset, offset + INTEGRITY_BLOCK_SIZE)));
    }
  }
  return {
    algorithm: 'SHA256',
    hash: sha256Hex(buf),
    blockSize: INTEGRITY_BLOCK_SIZE,
    blocks,
  };
}

/**
 * Parse an ASAR archive's Chromium Pickle header without extracting files to disk.
 */
export function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, prefix, 0, 16, 0);
    if (bytesRead < 16) {
      throw new Error(`Invalid ASAR file (too small): ${asarPath}`);
    }

    const outerPayloadSize = prefix.readUInt32LE(0);
    const headerPickleSize = prefix.readUInt32LE(4);
    const headerStringLen = prefix.readUInt32LE(12);

    if (outerPayloadSize !== 4 || headerPickleSize < 8 || headerStringLen === 0) {
      throw new Error(`Invalid ASAR Chromium Pickle header in: ${asarPath}`);
    }

    const jsonBuf = Buffer.alloc(headerStringLen);
    const jsonRead = fs.readSync(fd, jsonBuf, 0, headerStringLen, 16);
    if (jsonRead < headerStringLen) {
      throw new Error(`Truncated ASAR header JSON in: ${asarPath}`);
    }

    const header = JSON.parse(jsonBuf.toString('utf8'));
    const dataOffset = 8 + headerPickleSize;
    return { header, dataOffset };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Serialize header JSON into Electron's 2-level Chromium Pickle format.
 */
export function encodeAsarHeader(headerObj) {
  const jsonBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const stringLen = jsonBuf.length;
  const alignedLen = Math.ceil(stringLen / 4) * 4;
  const padLen = alignedLen - stringLen;

  const headerPayloadSize = 4 + alignedLen;
  const headerPickleSize = 4 + headerPayloadSize;

  const out = Buffer.alloc(16 + alignedLen);
  out.writeUInt32LE(4, 0); // outer pickle payload size (1 uint32)
  out.writeUInt32LE(headerPickleSize, 4); // outer pickle value: inner pickle total size
  out.writeUInt32LE(headerPayloadSize, 8); // inner pickle payload size
  out.writeUInt32LE(stringLen, 12); // string byte length
  jsonBuf.copy(out, 16);
  if (padLen > 0) {
    out.fill(0, 16 + stringLen, 16 + alignedLen);
  }
  return out;
}

/**
 * List all file entries inside the ASAR header with normalized forward-slash paths.
 */
export function listAsarFiles(header) {
  const results = [];
  const walk = (node, prefix) => {
    if (!node || !node.files) return;
    for (const [name, entry] of Object.entries(node.files)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        walk(entry, rel);
      } else {
        results.push({ path: rel, entry });
      }
    }
  };
  walk(header, '');
  return results;
}

/**
 * Lookup a single file entry by forward-slash relative path.
 */
export function getAsarEntry(header, relPath) {
  const parts = relPath.replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur || !cur.files || !Object.prototype.hasOwnProperty.call(cur.files, part)) {
      return null;
    }
    cur = cur.files[part];
  }
  return cur;
}

/**
 * Read a single packed file's bytes directly from an ASAR archive.
 */
export function readAsarFileBuffer(asarPath, relPath, parsed = null) {
  const { header, dataOffset } = parsed || readAsarHeader(asarPath);
  const entry = getAsarEntry(header, relPath);
  if (!entry || entry.files) {
    throw new Error(`File not found in ASAR: ${relPath}`);
  }
  if (entry.unpacked) {
    throw new Error(`Entry is unpacked (not stored inside ASAR body): ${relPath}`);
  }
  const size = Number(entry.size || 0);
  const offset = Number(entry.offset || 0);
  const buf = Buffer.alloc(size);
  if (size === 0) return buf;

  const fd = fs.openSync(asarPath, 'r');
  try {
    fs.readSync(fd, buf, 0, size, dataOffset + offset);
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function ensureDirNode(root, dirParts) {
  let cur = root;
  for (const part of dirParts) {
    if (!cur.files) cur.files = {};
    if (!cur.files[part]) {
      cur.files[part] = { files: {} };
    }
    cur = cur.files[part];
  }
  return cur;
}

/**
 * Rewrite an ASAR archive cleanly from `sourceAsarPath` to `destAsarPath`,
 * replacing or adding only files listed in `replacements` (Map<relPath, Buffer | string>).
 * All other packed files are streamed directly from `sourceAsarPath`, and all `unpacked: true`
 * entries and symlinks are preserved verbatim.
 */
export function rewriteAsarArchive(sourceAsarPath, destAsarPath, replacements) {
  const { header: srcHeader, dataOffset: srcDataOffset } = readAsarHeader(sourceAsarPath);
  const nextHeader = deepClone(srcHeader);

  const normalizedMap = new Map();
  for (const [rawPath, content] of replacements.entries()) {
    const norm = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    normalizedMap.set(norm, buf);
  }

  // Ensure any brand-new paths exist in nextHeader tree
  for (const [normPath, buf] of normalizedMap.entries()) {
    const parts = normPath.split('/');
    const fileName = parts.pop();
    const parent = ensureDirNode(nextHeader, parts);
    const prev = parent.files[fileName];
    parent.files[fileName] = {
      ...(prev && prev.executable ? { executable: true } : {}),
      size: buf.length,
      offset: '0',
      integrity: computeAsarIntegrity(buf),
    };
  }

  // Assign sequential offsets and build write plan
  const writePlan = [];
  let cursor = 0;

  const planWalk = (node, prefix) => {
    if (!node || !node.files) return;
    for (const [name, entry] of Object.entries(node.files)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        planWalk(entry, rel);
      } else if (entry.unpacked || entry.link) {
        // Preserve unpacked files and symlinks untouched — never touch app.asar.unpacked
        continue;
      } else if (normalizedMap.has(rel)) {
        const buf = normalizedMap.get(rel);
        entry.size = buf.length;
        entry.offset = String(cursor);
        entry.integrity = computeAsarIntegrity(buf);
        writePlan.push({ kind: 'buffer', buf });
        cursor += buf.length;
      } else {
        const srcEntry = getAsarEntry(srcHeader, rel);
        const srcOffset = Number(srcEntry.offset || 0);
        const size = Number(srcEntry.size || 0);
        entry.offset = String(cursor);
        writePlan.push({ kind: 'copy', srcOffset: srcDataOffset + srcOffset, size });
        cursor += size;
      }
    }
  };
  planWalk(nextHeader, '');

  const headerBuf = encodeAsarHeader(nextHeader);
  const srcFd = fs.openSync(sourceAsarPath, 'r');
  const dstFd = fs.openSync(destAsarPath, 'w');
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const copyBuf = Buffer.allocUnsafe(CHUNK_SIZE);

  try {
    fs.writeSync(dstFd, headerBuf, 0, headerBuf.length);
    for (const op of writePlan) {
      if (op.kind === 'buffer') {
        if (op.buf.length > 0) {
          fs.writeSync(dstFd, op.buf, 0, op.buf.length);
        }
      } else if (op.size > 0) {
        let remaining = op.size;
        let readPos = op.srcOffset;
        while (remaining > 0) {
          const toRead = Math.min(remaining, CHUNK_SIZE);
          const n = fs.readSync(srcFd, copyBuf, 0, toRead, readPos);
          if (n <= 0) {
            throw new Error(`Unexpected EOF while copying ASAR payload at offset ${readPos}`);
          }
          fs.writeSync(dstFd, copyBuf, 0, n);
          readPos += n;
          remaining -= n;
        }
      }
    }
  } finally {
    fs.closeSync(srcFd);
    fs.closeSync(dstFd);
  }
}

/**
 * Create a minimal ASAR archive from an in-memory map of { [relPath]: Buffer | string | { unpacked: true, size: number } }
 * (primarily for unit testing).
 */
export function buildAsarFromMap(destAsarPath, entriesMap) {
  const header = { files: {} };
  const buffers = [];
  let cursor = 0;

  for (const [rawPath, val] of Object.entries(entriesMap)) {
    const norm = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = norm.split('/');
    const fileName = parts.pop();
    const parent = ensureDirNode(header, parts);

    if (val && typeof val === 'object' && !Buffer.isBuffer(val) && val.unpacked) {
      parent.files[fileName] = { size: Number(val.size || 0), unpacked: true };
    } else {
      const buf = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8');
      parent.files[fileName] = {
        size: buf.length,
        offset: String(cursor),
        integrity: computeAsarIntegrity(buf),
      };
      buffers.push(buf);
      cursor += buf.length;
    }
  }

  const headerBuf = encodeAsarHeader(header);
  const fd = fs.openSync(destAsarPath, 'w');
  try {
    fs.writeSync(fd, headerBuf, 0, headerBuf.length);
    for (const buf of buffers) {
      if (buf.length > 0) fs.writeSync(fd, buf, 0, buf.length);
    }
  } finally {
    fs.closeSync(fd);
  }
}
