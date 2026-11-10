// Minimal asar extractor (no dependencies). Usage: node extract-asar.js <app.asar> <outDir>
const fs = require("fs");
const path = require("path");
const [, , asarPath, outDir] = process.argv;
const fd = fs.openSync(asarPath, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const hdr = Buffer.alloc(jsonLen);
fs.readSync(fd, hdr, 0, jsonLen, 16);
const header = JSON.parse(hdr.toString("utf8"));
const base = 8 + headerSize;
let count = 0;
function walk(node, rel) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const r = path.join(rel, name);
    if (entry.files) { walk(entry, r); continue; }
    if (entry.unpacked || entry.link) continue;
    const dest = path.join(outDir, r);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = Buffer.alloc(entry.size);
    if (entry.size) fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
    fs.writeFileSync(dest, buf);
    count++;
  }
}
walk(header, "");
console.log(`extracted ${count} files to ${outDir}`);
