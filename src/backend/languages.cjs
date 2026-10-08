const fs = require("node:fs/promises");
const path = require("node:path");
const { inside, noLinks } = require("./files.cjs");

// Steam language codes; only languages found in this client are offered.
const labels = {
  english: "英语",
  schinese: "简体中文",
  tchinese: "繁体中文",
  russian: "俄语",
  german: "德语",
  french: "法语",
  italian: "意大利语",
  spanish: "西班牙语",
  latam: "拉美西班牙语",
  portuguese: "葡萄牙语",
  brazilian: "巴西葡萄牙语",
  japanese: "日语",
  koreana: "韩语",
  korean: "韩语（旧资源）",
  polish: "波兰语",
  ukrainian: "乌克兰语",
  czech: "捷克语",
  danish: "丹麦语",
  dutch: "荷兰语",
  finnish: "芬兰语",
  norwegian: "挪威语",
  swedish: "瑞典语",
  hungarian: "匈牙利语",
  romanian: "罗马尼亚语",
  bulgarian: "保加利亚语",
  greek: "希腊语",
  turkish: "土耳其语",
  thai: "泰语",
  vietnamese: "越南语",
  indonesian: "印度尼西亚语",
  arabic: "阿拉伯语",
};
function languageCode(value = "english") {
  if (typeof value !== "string" || !Object.hasOwn(labels, value))
    throw Error("游戏语言无效");
  return value;
}
function addName(found, name) {
  const code = /^dota_([a-z]+)\.txt$/i.exec(name)?.[1].toLowerCase();
  if (code && Object.hasOwn(labels, code)) found.add(code);
}
// Read only the bounded VPK directory tree, never extract or load game data.
function parseVpkTree(tree) {
  let offset = 0;
  const found = new Set();
  const string = () => {
    const end = tree.indexOf(0, offset);
    if (end < offset || end - offset > 4096) throw Error("VPK 目录字符串损坏");
    const result = tree.toString("utf8", offset, end);
    offset = end + 1;
    return result;
  };
  for (let extension; offset < tree.length && (extension = string());) {
    for (let directory; (directory = string());) {
      for (let name; (name = string());) {
        if (
          offset + 18 > tree.length ||
          tree.readUInt16LE(offset + 16) !== 65535
        )
          throw Error("VPK 目录条目损坏");
        const preload = tree.readUInt16LE(offset + 4);
        offset += 18 + preload;
        if (offset > tree.length) throw Error("VPK 预载数据截断");
        if (
          extension === "txt" &&
          [
            "resource",
            "resource/localization",
            "panorama/localization",
          ].includes(directory.replaceAll("\\", "/"))
        )
          addName(found, name + ".txt");
      }
    }
  }
  return found;
}
async function readVpkLanguages(file) {
  await noLinks(file);
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(12);
    const first = await handle.read(header, 0, 12, 0);
    if (first.bytesRead !== 12 || header.readUInt32LE(0) !== 0x55aa1234)
      throw Error("VPK 文件头损坏");
    const version = header.readUInt32LE(4),
      size = header.readUInt32LE(8);
    if (![1, 2].includes(version) || size < 1 || size > 64 * 1024 ** 2)
      throw Error("VPK 目录大小或版本无效");
    const start = version === 1 ? 12 : 28;
    if ((await handle.stat()).size < start + size) throw Error("VPK 目录截断");
    const tree = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const next = await handle.read(tree, read, size - read, start + read);
      if (!next.bytesRead) throw Error("VPK 目录截断");
      read += next.bytesRead;
    }
    return parseVpkTree(tree);
  } finally {
    await handle.close();
  }
}
async function detectLanguages(entry, root) {
  const game = inside(root, entry.source2 ? "game/dota" : "dota");
  await noLinks(game);
  const found = new Set(),
    warnings = [];
  for (const relative of [
    "resource",
    "resource/localization",
    "panorama/localization",
  ]) {
    const dir = inside(game, relative);
    await noLinks(dir);
    let files;
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") warnings.push("语言目录无法读取");
      continue;
    }
    for (const file of files) if (file.isFile()) addName(found, file.name);
  }
  // The base VPK contains UI localization in later clients.
  const file = inside(game, "pak01_dir.vpk");
  try {
    for (const code of await readVpkLanguages(file)) found.add(code);
  } catch (error) {
    if (error.code !== "ENOENT") warnings.push("VPK 语言目录无法读取");
  }
  if (found.has("koreana")) found.delete("korean");
  const detected = found.size;
  found.add("english"); // Existing verified English entry remains the fallback.
  const languages = Object.keys(labels)
    .filter((code) => found.has(code))
    .map((code) => ({ code, label: labels[code] }));
  return {
    languages,
    languageNote: warnings.length
      ? "语言资源扫描不完整，语音与未翻译内容由原包决定。"
      : detected
        ? "界面语言；语音与未翻译内容由原包决定。"
        : "未检测到其他界面语言，保留英语入口。",
  };
}
module.exports = { languageCode, detectLanguages, parseVpkTree };
