const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const root = path.resolve(__dirname, ".."),
  assets = path.join(root, "src/ui/assets");
fs.mkdirSync(assets, { recursive: true });
fs.mkdirSync(path.join(root, "resources/licenses"), { recursive: true });
const fonts = path.join(assets, "fonts");
fs.mkdirSync(fonts, { recursive: true });
let css = "";
for (const [pkg, files] of [
  ["noto-sans-sc", ["400.css"]],
  ["noto-serif-sc", ["600.css"]],
  ["cinzel", ["latin-700.css"]],
  ["barlow-condensed", ["latin-600.css", "latin-700.css"]],
]) {
  const dir = path.join(root, "node_modules/@fontsource", pkg);
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    css +=
      text.replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (_m, _q, url) => {
        const name = path.basename(url);
        fs.copyFileSync(path.resolve(dir, url), path.join(fonts, name));
        return "url(./" + name + ")";
      }) + "\n";
  }
  fs.copyFileSync(
    path.join(dir, "LICENSE"),
    path.join(root, "resources/licenses", pkg + "-OFL.txt"),
  );
}
fs.writeFileSync(path.join(fonts, "fonts.css"), css);
fs.copyFileSync(
  path.join(root, "node_modules/lucide/dist/umd/lucide.js"),
  path.join(assets, "lucide.js"),
);
fs.copyFileSync(
  path.join(root, "node_modules/lucide/LICENSE"),
  path.join(root, "resources/licenses/lucide-ISC.txt"),
);
// An original archive-mark icon, rasterized directly from its geometric definition.
const n = 256,
  rgba = Buffer.alloc(n * (n * 4 + 1));
for (let y = 0; y < n; y++)
  for (let x = 0; x < n; x++) {
    const p = y * (n * 4 + 1) + 1 + x * 4;
    let c = [16, 19, 23, 255];
    if (x >= 52 && x <= 60 && y >= 48 && y <= 206) c = [185, 190, 198, 255];
    if (
      (x - 56) ** 2 + (y - 62) ** 2 < 16 ** 2 ||
      (x - 56) ** 2 + (y - 132) ** 2 < 11 ** 2 ||
      (x - 56) ** 2 + (y - 198) ** 2 < 11 ** 2
    )
      c = [228, 91, 60, 255];
    if (x >= 88 && x <= 196 && ((y >= 54 && y <= 70) || (y >= 124 && y <= 140)))
      c = [241, 240, 236, 255];
    if (x >= 88 && x <= 154 && y >= 190 && y <= 206) c = [241, 240, 236, 255];
    for (let i = 0; i < 4; i++) rgba[p + i] = c[i];
  }
function crc32(data) {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type),
    out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), data.length + 8);
  return out;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(n);
ihdr.writeUInt32BE(n, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(rgba)),
  chunk("IEND", Buffer.alloc(0)),
]);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
fs.writeFileSync(
  path.join(root, "resources/icon.ico"),
  Buffer.concat([ico, png]),
);
console.log("Offline fonts, Lucide icons and original app icon built.");
