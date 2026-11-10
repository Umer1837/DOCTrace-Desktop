// Builds resources\app.asar from app-source\ (no dependencies).
// Usage: node tools/pack-asar.js <app-source dir> <app.asar.unpacked dir> <output app.asar>
//
// Everything in <app-source> is packed into the archive. Files in <app.asar.unpacked>
// (the native click hook, uiohook-napi) stay on disk next to the archive; they are only
// listed in the header with "unpacked": true, exactly like electron-builder does.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const [, , srcDir, unpackedDir, outFile] = process.argv;
if (!srcDir || !unpackedDir || !outFile) {
  console.error("Usage: node pack-asar.js <app-source> <app.asar.unpacked> <out app.asar>");
  process.exit(1);
}

const BLOCK = 4 * 1024 * 1024;
function integrity(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK) blocks.push(crypto.createHash("sha256").update(buf.subarray(i, i + BLOCK)).digest("hex"));
  if (!blocks.length) blocks.push(crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  return { algorithm: "SHA256", hash: crypto.createHash("sha256").update(buf).digest("hex"), blockSize: BLOCK, blocks };
}

const header = { files: {} };
const chunks = [];
let offset = 0;
let packed = 0;
let unpacked = 0;

function dirNode(rel, markUnpacked) {
  let node = header;
  for (const part of rel.split("/").filter(Boolean)) {
    // A folder is "unpacked" only when it exists solely outside the archive
    // (node_modules/uiohook-napi), not when it also holds packed files (node_modules).
    if (!node.files[part]) node.files[part] = markUnpacked ? { files: {}, unpacked: true } : { files: {} };
    node = node.files[part];
  }
  return node;
}

function walk(base, rel, isUnpacked) {
  const abs = path.join(base, rel);
  const names = fs.readdirSync(abs).sort();
  for (const name of names) {
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(path.join(base, r));
    if (st.isDirectory()) {
      dirNode(r, isUnpacked);
      walk(base, r, isUnpacked);
      continue;
    }
    const buf = fs.readFileSync(path.join(base, r));
    const parent = dirNode(rel, isUnpacked);
    if (isUnpacked) {
      parent.files[name] = { size: buf.length, unpacked: true, integrity: integrity(buf) };
      unpacked++;
    } else {
      if (parent.files[name]) throw new Error(`Duplicate file: ${r}`);
      parent.files[name] = { size: buf.length, integrity: integrity(buf), offset: String(offset) };
      chunks.push(buf);
      offset += buf.length;
      packed++;
    }
  }
}

walk(path.resolve(srcDir), "", false);
walk(path.resolve(unpackedDir), "", true);

const json = Buffer.from(JSON.stringify(header), "utf8");
const padded = Math.ceil(json.length / 4) * 4;
const headerPickle = Buffer.alloc(8 + padded);
headerPickle.writeUInt32LE(4 + padded, 0);
headerPickle.writeUInt32LE(json.length, 4);
json.copy(headerPickle, 8);
const sizePickle = Buffer.alloc(8);
sizePickle.writeUInt32LE(4, 0);
sizePickle.writeUInt32LE(headerPickle.length, 4);

fs.writeFileSync(outFile, Buffer.concat([sizePickle, headerPickle, ...chunks]));
console.log(`packed ${packed} files, listed ${unpacked} unpacked files -> ${outFile} (${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB)`);
