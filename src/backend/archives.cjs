// Offline acquisition metadata is independent of launch capabilities.
const fs = require("node:fs/promises");
const path = require("node:path");
const { inside, noLinks, readJson } = require("./files.cjs");
const validId =
  /^(patch-[67]\.\d{2}[a-z]?|snapshot-[a-zA-Z0-9_.-]+|archive-[a-zA-Z0-9_.-]+)$/;
async function readArchiveIndex(root) {
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw Error("请选择归档文件夹的绝对路径");
  await noLinks(root);
  root = await fs.realpath(root);
  const file = inside(root, "archive-index.json");
  await noLinks(file);
  if ((await fs.stat(file)).size > 2 * 1024 * 1024) throw Error("归档索引过大");
  const index = await readJson(file);
  if (
    index.schema !== 1 ||
    !Array.isArray(index.entries) ||
    index.entries.length > 500
  )
    throw Error("归档索引格式无效");
  const ids = new Set();
  for (const row of index.entries) {
    if (!validId.test(row.historyId) || ids.has(row.historyId))
      throw Error("归档记录编号无效或重复");
    ids.add(row.historyId);
    if (
      typeof row.version !== "string" ||
      row.version.length > 80 ||
      !Array.isArray(row.files) ||
      row.files.length > 20
    )
      throw Error("归档记录格式无效");
    await noLinks(inside(root, row.folder));
    for (const item of row.files) {
      if (!Number.isSafeInteger(item.bytes) || item.bytes < 1)
        throw Error("归档文件长度无效");
      await noLinks(inside(root, item.path));
    }
  }
  return { root, index };
}
async function archiveSnapshot(root, sourceCatalog = { entries: [] }) {
  const sources = (sourceCatalog.entries || []).filter(
    (s) =>
      validId.test(s.historyId) &&
      s.kind === "download-entry" &&
      typeof s.sourceUrl === "string" &&
      /^https:\/\//.test(s.sourceUrl),
  );
  const result = { archiveRoot: root || "", sources, records: [], error: null };
  if (!root) return result;
  try {
    const checked = await readArchiveIndex(root);
    result.archiveRoot = checked.root;
    result.reviewDate = checked.index.reviewDate;
    result.records = await Promise.all(
      checked.index.entries.map(async (row) => {
        let archivePresent = row.files.length > 0;
        for (const item of row.files) {
          try {
            const stat = await fs.stat(inside(checked.root, item.path));
            if (!stat.isFile() || stat.size !== item.bytes)
              archivePresent = false;
          } catch {
            archivePresent = false;
          }
        }
        return {
          historyId: row.historyId,
          version: row.version,
          folder: row.folder,
          usable: row.usable === true,
          collectionClaim: row.collectionClaim === true,
          sourceLabel: row.sourceLabel || "归档记录",
          note: row.note || "",
          archivePresent,
          fileCount: row.files.length,
          archiveBytes: archivePresent
            ? row.files.reduce((sum, f) => sum + f.bytes, 0)
            : 0,
        };
      }),
    );
  } catch (error) {
    result.error = error.message;
  }
  return result;
}
async function archiveFolder(root, id) {
  const { root: base, index } = await readArchiveIndex(root);
  if (!id) return base;
  const record = index.entries.find((r) => r.historyId === id);
  if (!record) throw Error("未知归档记录");
  const folder = inside(base, record.folder);
  await noLinks(folder);
  if (!(await fs.stat(folder)).isDirectory()) throw Error("归档文件夹不存在");
  return folder;
}
module.exports = { readArchiveIndex, archiveSnapshot, archiveFolder };
