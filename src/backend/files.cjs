const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const hash = async (p) =>
  crypto
    .createHash("sha256")
    .update(await fs.readFile(p))
    .digest("hex");
async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
async function readJson(p) {
  return JSON.parse((await fs.readFile(p, "utf8")).replace(/^\uFEFF/, ""));
}
async function writeJson(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + "." + crypto.randomUUID() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, p);
}
function inside(base, relative) {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    relative.includes("\0")
  )
    throw Error("不安全的相对路径");
  const result = path.resolve(base, relative),
    r = path.relative(path.resolve(base), result);
  if (!r || r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r))
    throw Error("路径必须位于对应客户端内");
  return result;
}
async function noLinks(p) {
  let current = path.resolve(p);
  for (;;) {
    try {
      const s = await fs.lstat(current);
      if (s.isSymbolicLink())
        throw Error("请使用实际文件夹，不支持符号链接或目录联接：" + current);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
}
async function treeFingerprint(root) {
  await noLinks(root);
  const rows = [];
  async function walk(p) {
    for (const e of (await fs.readdir(p, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const child = path.join(p, e.name);
      if (e.isSymbolicLink()) throw Error("活动目录内存在链接：" + child);
      if (e.isDirectory()) await walk(child);
      else if (e.isFile())
        rows.push([
          path.relative(root, child).replaceAll("\\", "/"),
          await hash(child),
        ]);
    }
  }
  await walk(root);
  return JSON.stringify(rows);
}
module.exports = {
  hash,
  exists,
  readJson,
  writeJson,
  inside,
  noLinks,
  treeFingerprint,
};
