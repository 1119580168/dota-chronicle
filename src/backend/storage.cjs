const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
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

// Explicit recovery export keeps the original sessions and lifecycle evidence.
// The destination is always a newly created directory; no existing profile wins
// or gets overwritten, and no old registry/client path is accessed here.
async function exportBindings(source, parent, config) {
  source = path.resolve(source);
  parent = path.resolve(parent);
  await noLinks(source);
  await noLinks(parent);
  const relative = path.relative(path.resolve(source), path.resolve(parent));
  if (
    !relative ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw Error("请选择当前 data 之外的父目录，以便保留旧会话证据");
  const mediaConfigFile = path.join(source, "media.json");
  let mediaConfig, mediaConfigBytes;
  try {
    await noLinks(mediaConfigFile);
    mediaConfigBytes = await fs.readFile(mediaConfigFile);
    mediaConfig = JSON.parse(
      mediaConfigBytes.toString("utf8").replace(/^\uFEFF/, ""),
    );
    if (
      !mediaConfig ||
      typeof mediaConfig !== "object" ||
      Array.isArray(mediaConfig) ||
      typeof mediaConfig.root !== "string" ||
      !mediaConfig.root.trim() ||
      !path.isAbsolute(mediaConfig.root)
    )
      throw Error("媒体配置必须指定实际绝对目录 root");
  } catch (error) {
    if (error.code !== "ENOENT")
      throw Error(
        "媒体配置无法导出：" +
          error.message +
          "。请修复配置后重试，原文件与旧会话证据未改写。",
      );
  }
  const mediaRoot = mediaConfig
    ? path.resolve(mediaConfig.root)
    : path.join(source, "media");
  const mediaRelative = path.relative(source, mediaRoot);
  if (!mediaRelative)
    throw Error(
      "不能把整个 data 作为媒体库导出，请先修复媒体 root，旧会话证据未改写",
    );
  const internalMedia =
    mediaRelative !== ".." &&
    !mediaRelative.startsWith(".." + path.sep) &&
    !path.isAbsolute(mediaRelative);
  if (internalMedia) {
    if (
      ["sessions", "client.lock", "compat-backups"].includes(
        mediaRelative.split(path.sep)[0].toLowerCase(),
      )
    )
      throw Error(
        "媒体 root 位于会话或租约证据目录，不能作为媒体导出，原文件未改写",
      );
    await noLinks(mediaRoot);
    const mediaStat = await optionalStat(mediaRoot);
    if (mediaStat && !mediaStat.isDirectory())
      throw Error("内置媒体 root 必须是实际文件夹，原文件未改写");
  }
  const target = path.join(parent, "data-recovery-" + crypto.randomUUID());
  await fs.mkdir(target);
  async function copy(sourceFile, targetFile) {
    await noLinks(sourceFile);
    const stat = await optionalStat(sourceFile);
    if (!stat) return;
    if (stat.isDirectory()) {
      await fs.mkdir(targetFile);
      for (const entry of await fs.readdir(sourceFile, {
        withFileTypes: true,
      })) {
        if (entry.isSymbolicLink())
          throw Error("媒体目录含链接，已停止导出并保留原文件");
        await copy(
          path.join(sourceFile, entry.name),
          path.join(targetFile, entry.name),
        );
      }
    } else if (stat.isFile()) {
      await fs.copyFile(sourceFile, targetFile, constants.COPYFILE_EXCL);
    } else throw Error("媒体目录包含特殊文件，已停止导出并保留原文件");
  }
  if (internalMedia) {
    // Omitting media.json uses the profile-relative default, so a later move or
    // rename of this exported data does not retain any old absolute media root.
    await copy(mediaRoot, path.join(target, "media"));
  } else {
    // External roots may belong to another computer or an unavailable drive.
    // Keep their binding bytes without inspecting or copying that location.
    await fs.writeFile(path.join(target, "media.json"), mediaConfigBytes, {
      flag: "wx",
      mode: 0o600,
    });
    await fs.writeFile(
      path.join(target, "MEDIA-RECOVERY-INSTRUCTIONS.txt"),
      "外置媒体绑定已保留，素材未复制，程序未访问原外置目录。\n原外置媒体目录：" +
        mediaConfig.root +
        "\n迁移到其他电脑后，请重新绑定本机实际媒体目录；确认媒体配置与索引可读取后再导入。\n",
      { flag: "wx" },
    );
  }
  await fs.writeFile(
    path.join(target, "library.json"),
    JSON.stringify(config, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return target;
}

module.exports = { dataDirectory, prepareStorage, exportBindings };
