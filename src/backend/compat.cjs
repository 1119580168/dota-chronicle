const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const f = require("./files.cjs");
const digest = (b) => crypto.createHash("sha256").update(b).digest("hex");
async function prepare(id, root, resources, data) {
  const r = (await f.readJson(path.join(resources, "recipes.json"))).find(
    (r) => r.id === id,
  );
  if (!r) throw Error("没有此活动的兼容方案");
  const file = f.inside(root, r.path);
  await f.noLinks(file);
  const original = await fs.readFile(file),
    current = digest(original);
  if (![r.originalSha, r.patchedSha].includes(current))
    throw Error("活动文件不是已验证的原版，已保留当前内容");
  let candidate = original;
  if (current === r.originalSha) {
    const old = Buffer.from(r.old, "base64"),
      replacement = Buffer.from(r.replacement, "base64");
    if (!original.subarray(r.offset, r.offset + old.length).equals(old))
      throw Error("活动文件差异不符合已验证方案");
    candidate = Buffer.concat([
      original.subarray(0, r.offset),
      replacement,
      original.subarray(r.offset + old.length),
    ]);
    if (digest(candidate) !== r.patchedSha)
      throw Error("兼容入口结果指纹不符合方案");
  }
  let adapter;
  if (r.adapter) {
    adapter = f.inside(root, r.adapter.path);
    await f.noLinks(adapter);
    if ((await f.exists(adapter)) && (await f.hash(adapter)) !== r.adapter.sha)
      throw Error("兼容适配文件已被外部修改，拒绝覆盖");
    if (
      (await f.hash(path.join(resources, r.adapter.resource))) !== r.adapter.sha
    )
      throw Error("程序适配资源完整性校验失败");
  }
  const dir = path.join(data, "compat-backups", crypto.randomUUID());
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "original.bin"), original, { flag: "wx" });
  await f.writeJson(path.join(dir, "record.json"), {
    id,
    file,
    originalSha: current,
    candidateSha: r.patchedSha,
    createdUtc: new Date().toISOString(),
    installed: false,
  });
  if ((await f.hash(file)) !== current)
    throw Error("文件在准备过程中变化，未覆盖");
  const temp = file + ".chronicle-" + crypto.randomUUID() + ".tmp";
  try {
    if (adapter && !(await f.exists(adapter)))
      await fs.copyFile(
        path.join(resources, r.adapter.resource),
        adapter,
        require("node:fs").constants.COPYFILE_EXCL,
      );
    if (current !== r.patchedSha) {
      await fs.writeFile(temp, candidate, { flag: "wx" });
      await fs.rename(temp, file);
    }
    await f.writeJson(path.join(dir, "record.json"), {
      id,
      file,
      originalSha: current,
      candidateSha: r.patchedSha,
      createdUtc: new Date().toISOString(),
      installed: true,
    });
  } finally {
    await fs.unlink(temp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  return { backup: dir, ready: true };
}
module.exports = { prepare };
