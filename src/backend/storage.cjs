const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { readJson, noLinks } = require("./files.cjs");

function dataDirectory({ packaged, executable, appData, override }) {
  if (override) return path.resolve(override);
  return packaged
    ? path.join(path.dirname(executable), "data")
    : path.join(appData, "Dota Chronicle");
}

async function optionalStat(file) {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Keep user settings outside Windows package-specific AppData views.
// Existing portable data always wins; an explicit test profile stays isolated.
async function prepareStorage(target, legacy) {
  await noLinks(target);
  await fs.mkdir(target, { recursive: true });
  if (!legacy || path.resolve(target) === path.resolve(legacy)) return;
  if (await optionalStat(path.join(target, "library.json"))) return;
  if (!(await optionalStat(path.join(legacy, "library.json")))) return;
  await noLinks(legacy);
  const config = await readJson(path.join(legacy, "library.json"));
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw Error("旧绑定配置格式错误，请先检查本机配置文件");

  const sessionRoot = path.join(legacy, "sessions");
  if (await optionalStat(sessionRoot)) {
    for (const entry of await fs.readdir(sessionRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const state = await readJson(
        path.join(sessionRoot, entry.name, "state.json"),
      );
      if (!["finished", "failed"].includes(state.stage))
        throw Error(
          "旧配置中有尚未结束或恢复的游戏会话，请先用旧启动器结束会话",
        );
    }
  }

  async function copyTree(source, destination) {
    await noLinks(source);
    const stat = await optionalStat(source);
    if (!stat) return;
    if (stat.isDirectory()) {
      await noLinks(destination);
      await fs.mkdir(destination, { recursive: true });
      for (const entry of await fs.readdir(source, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw Error("旧配置含链接，不能自动迁移");
        await copyTree(
          path.join(source, entry.name),
          path.join(destination, entry.name),
        );
      }
    } else if (stat.isFile()) {
      await noLinks(destination);
      try {
        await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
  }

  // Copy the binding last, so interrupted imports can resume without replacing
  // any already-written settings or losing detached-session recovery evidence.
  for (const name of ["media.json", "media", "sessions", "compat-backups"])
    await copyTree(path.join(legacy, name), path.join(target, name));
  await copyTree(
    path.join(legacy, "library.json"),
    path.join(target, "library.json"),
  );
}

module.exports = { dataDirectory, prepareStorage };
