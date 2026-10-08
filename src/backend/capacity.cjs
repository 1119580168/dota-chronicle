const fs = require("node:fs/promises");
const f = require("./files.cjs");
const GIB = 1024 ** 3;
const MAX_POLICY_BYTES = 16384;
const plainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function normalizeReserves(value) {
  if (!plainObject(value)) throw Error("容量保留配置必须是对象");
  const reserves = Object.create(null);
  for (const [drive, gib] of Object.entries(value)) {
    const key = drive.toUpperCase();
    if (!/^[A-Z]:$/.test(key) || Object.hasOwn(reserves, key))
      throw Error("容量保留配置中的盘符无效或重复");
    if (
      typeof gib !== "number" ||
      !Number.isFinite(gib) ||
      gib < 0 ||
      gib > 16384
    )
      throw Error("容量保留值必须是 0 至 16384 的有限 GiB 数值");
    reserves[key] = gib;
  }
  return reserves;
}

async function loadPolicy(data) {
  const file = f.inside(data, "storage-reserves.json");
  await f.noLinks(file);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error.code === "ENOENT") return Object.create(null);
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_POLICY_BYTES)
    throw Error("容量保留配置必须是不超过 16 KiB 的普通文件");
  const bytes = await fs.readFile(file);
  if (bytes.length > MAX_POLICY_BYTES) throw Error("容量保留配置超过 16 KiB");
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw Error("容量保留配置不是有效 JSON，请修正后重试");
  }
  if (
    !plainObject(document) ||
    document.schema !== 1 ||
    Object.keys(document).some(
      (key) => !["schema", "reservesGiB"].includes(key),
    )
  )
    throw Error("容量保留配置必须使用 schema 1 和 reservesGiB");
  return normalizeReserves(document.reservesGiB);
}

function assertRuntimeCapacity(disk, policy = {}) {
  const reserves = normalizeReserves(policy);
  if (!disk) {
    if (Object.keys(reserves).length)
      throw Error("无法读取磁盘容量，不能验证保留配置");
    return;
  }
  const drive = String(disk.DeviceID).toUpperCase();
  if (!Object.hasOwn(reserves, drive)) return;
  const free = Number(disk.FreeSpace);
  if (!Number.isFinite(free) || free < 0)
    throw Error("无法读取该磁盘的可用容量");
  const reserve = reserves[drive];
  if (free <= reserve * GIB)
    throw Error(
      `${drive} 空间已接近保留线，请保留超过 ${reserve} GiB 的可用空间`,
    );
}

module.exports = { loadPolicy, assertRuntimeCapacity };
