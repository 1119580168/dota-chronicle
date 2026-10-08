const fs = require("node:fs/promises");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { inside, noLinks } = require("./files.cjs");
const { languageCode } = require("./languages.cjs");

const TARGET = "game/dota/scripts/npc/chronicle_skill_localization_v1.txt";
const MAX_TREE = 64 * 1024 ** 2;
const MAX_SOURCE = 8 * 1024 ** 2;
const MAX_OUTPUT = 2 * 1024 ** 2;
const MAX_NAMES = 20000;
const NAME = /^[a-z0-9_]{1,160}$/;
const LOCALIZATIONS = Object.freeze([
  "resource/localization/abilities_english.txt",
  "resource/localization/abilities_schinese.txt",
  "resource/localization/items_english.txt",
  "resource/localization/items_schinese.txt",
]);
const DEFINITIONS = Object.freeze([
  "scripts/npc/npc_abilities.txt",
  "scripts/npc/items.txt",
]);
const ALLOWED_ENTRIES = new Set([...LOCALIZATIONS, ...DEFINITIONS]);

async function readAt(handle, position, length, message) {
  const stat = await handle.stat();
  if (
    !stat.isFile() ||
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    position < 0 ||
    length < 0 ||
    position + length > stat.size
  )
    throw Error(message);
  const bytes = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    const next = await handle.read(
      bytes,
      count,
      length - count,
      position + count,
    );
    if (!next.bytesRead) throw Error(message);
    count += next.bytesRead;
  }
  return bytes;
}

function safeTreePart(value, directory = false) {
  if (value === " ") return;
  if (
    !value ||
    /[\\:\x00-\x1f\x7f]/.test(value) ||
    value.startsWith("/") ||
    (!directory && value.includes("/")) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("VPK 目录含不安全的资源路径");
}

function parseTree(tree, wanted) {
  let position = 0;
  const entries = new Map();
  const string = () => {
    const end = tree.indexOf(0, position);
    if (end < position || end - position > 4096)
      throw Error("VPK 目录字符串损坏");
    const value = new TextDecoder("utf-8", { fatal: true }).decode(
      tree.subarray(position, end),
    );
    position = end + 1;
    return value;
  };
  for (let extension; (extension = string());) {
    safeTreePart(extension);
    for (let directory; (directory = string());) {
      safeTreePart(directory, true);
      for (let name; (name = string());) {
        safeTreePart(name);
        if (
          position + 18 > tree.length ||
          tree.readUInt16LE(position + 16) !== 65535
        )
          throw Error("VPK 目录条目损坏");
        const preloadSize = tree.readUInt16LE(position + 4);
        const entry = {
          archive: tree.readUInt16LE(position + 6),
          offset: tree.readUInt32LE(position + 8),
          length: tree.readUInt32LE(position + 12),
        };
        position += 18;
        if (position + preloadSize > tree.length)
          throw Error("VPK 预载数据截断");
        const relative =
          (directory === " " ? "" : directory + "/") +
          name +
          (extension === " " ? "" : "." + extension);
        if (wanted.has(relative)) {
          if (entries.has(relative)) throw Error("VPK 技能名称资源重复");
          if (entry.length + preloadSize > MAX_SOURCE || entry.archive > 0x7fff)
            throw Error("VPK 技能名称资源大小或分块无效");
          entry.preload = tree.subarray(position, position + preloadSize);
          entries.set(relative, entry);
        }
        position += preloadSize;
      }
    }
  }
  if (position !== tree.length) throw Error("VPK 目录存在多余或截断数据");
  return entries;
}

async function readEntries(root, wanted) {
  for (const name of wanted)
    if (!ALLOWED_ENTRIES.has(name)) throw Error("技能名称资源超出白名单");
  const directory = inside(root, "game/dota/pak01_dir.vpk");
  await noLinks(directory);
  const handle = await fs.open(directory, "r");
  try {
    const first = await readAt(handle, 0, 12, "VPK 文件头截断");
    const version = first.readUInt32LE(4),
      size = first.readUInt32LE(8);
    if (
      first.readUInt32LE(0) !== 0x55aa1234 ||
      ![1, 2].includes(version) ||
      size < 1 ||
      size > MAX_TREE
    )
      throw Error("VPK 文件头、版本或目录大小无效");
    const start = version === 1 ? 12 : 28;
    const extra =
      version === 2 ? await readAt(handle, 12, 16, "VPK 文件头截断") : null;
    const tree = await readAt(handle, start, size, "VPK 目录截断");
    const entries = parseTree(tree, wanted);
    const result = new Map();
    for (const name of wanted) {
      const entry = entries.get(name);
      if (!entry) throw Error("原版 VPK 缺少技能名称或定义资源：" + name);
      let payload = Buffer.alloc(0);
      if (entry.length) {
        if (entry.archive === 0x7fff) {
          if (extra && entry.offset + entry.length > extra.readUInt32LE(0))
            throw Error("VPK 内嵌资源超出数据区");
          payload = await readAt(
            handle,
            start + size + entry.offset,
            entry.length,
            "VPK 内嵌技能名称资源截断",
          );
        } else {
          const part = inside(
            root,
            "game/dota/pak01_" +
              String(entry.archive).padStart(3, "0") +
              ".vpk",
          );
          await noLinks(part);
          const archive = await fs.open(part, "r");
          try {
            payload = await readAt(
              archive,
              entry.offset,
              entry.length,
              "VPK 分块技能名称资源截断",
            );
          } finally {
            await archive.close();
          }
        }
      }
      result.set(name, Buffer.concat([entry.preload, payload]));
    }
    return result;
  } finally {
    await handle.close();
  }
}

async function looseDefinition(root, relative) {
  const file = inside(root, "game/dota/" + relative);
  await noLinks(file);
  let handle;
  try {
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SOURCE)
      throw Error("原版技能定义文件大小无效");
    return await readAt(handle, 0, stat.size, "原版技能定义文件截断");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

// A depth-aware token scan only collects definition block names under the
// DOTAAbilities root; nested parameter keys and comment/string braces are ignored.
function definitionIds(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const ids = new Set();
  let position = 0,
    depth = 0,
    previous = null,
    rootSeen = false,
    rootClosed = false;
  while (position < text.length) {
    const character = text[position];
    if (/\s/.test(character)) {
      position++;
      continue;
    }
    if (text.startsWith("//", position)) {
      const end = text.indexOf("\n", position + 2);
      position = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("/*", position)) {
      const end = text.indexOf("*/", position + 2);
      if (end < 0) throw Error("原版技能定义注释截断");
      position = end + 2;
      continue;
    }
    if (character === '"') {
      const start = ++position;
      let escaped = false;
      while (position < text.length) {
        if (!escaped && text[position] === '"') break;
        if (!escaped && text[position] === "\\") escaped = true;
        else escaped = false;
        position++;
      }
      if (position >= text.length || position - start > 8192)
        throw Error("原版技能定义字符串截断或过长");
      previous = text.slice(start, position++);
      continue;
    }
    if (character === "{") {
      if (depth === 0) {
        if (rootSeen || rootClosed || previous !== "DOTAAbilities")
          throw Error("原版技能定义根节点无效");
        rootSeen = true;
      } else if (depth === 1 && NAME.test(previous || "")) {
        ids.add(previous);
        if (ids.size > MAX_NAMES) throw Error("原版技能定义数量过多");
      }
      if (++depth > 64) throw Error("原版技能定义嵌套过深");
      previous = null;
      position++;
      continue;
    }
    if (character === "}") {
      if (--depth < 0) throw Error("原版技能定义括号无效");
      if (depth === 0) rootClosed = true;
      previous = null;
      position++;
      continue;
    }
    // Scalar/bare tokens and conditional expressions are not definition keys.
    while (position < text.length && !/[\s{}"]/.test(text[position]))
      position++;
    previous = null;
  }
  if (!rootSeen || !rootClosed || depth !== 0 || !ids.size)
    throw Error("原版技能定义未完整结束或没有技能");
  return ids;
}

function unescape(value) {
  return value.replace(
    /\\([\\"nrt])/g,
    (_, escaped) =>
      ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" })[escaped],
  );
}

function localizationText(bytes, allowUtf8) {
  if (bytes.length < 2 || bytes.length > MAX_SOURCE)
    throw Error("原版技能名称资源大小无效");
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    throw Error("原版技能名称资源不是有效 UTF-16LE");
  const markedUtf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  const unmarkedUtf16 =
    bytes.length >= 4 &&
    bytes[0] > 0 &&
    bytes[0] < 128 &&
    bytes[1] === 0 &&
    bytes[2] > 0 &&
    bytes[2] < 128 &&
    bytes[3] === 0;
  // The 2019 source is UTF-16LE; the verified 2020 source is UTF-8 BOM.
  // Select encoding before decoding. Malformed marked UTF-16 never falls back
  // to UTF-8, and malformed UTF-8 never becomes replacement-character text.
  const encoding =
    markedUtf16 || unmarkedUtf16 ? "utf-16le" : allowUtf8 ? "utf-8" : null;
  if (!encoding || (encoding === "utf-16le" && bytes.length % 2))
    throw Error("原版技能名称资源不是有效 UTF-16LE");
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw Error("原版技能名称资源含无效字符");
  return text;
}

function names(bytes, ids, allowUtf8 = false) {
  const text = localizationText(bytes, allowUtf8);
  const result = new Map();
  const pattern =
    /^[ \t]*"DOTA_Tooltip_ability_([a-z0-9_]{1,160})"[ \t]+"((?:\\.|[^"\\\r\n])*)"[ \t]*(?:\[[^\]\r\n]*\][ \t]*)?(?:\/\/[^\r\n]*)?\r?$/gm;
  for (let match; (match = pattern.exec(text));) {
    if (!ids.has(match[1])) continue;
    const value = unescape(match[2]).replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (value.length > 256 || /[\x00-\x1f\x7f]/.test(value))
      throw Error("原版技能名称过长或含无效字符");
    result.set(match[1], value);
  }
  return result;
}

function quote(value) {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

async function generate(root, language = "english", profile = "722-v1") {
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw Error("技能名称读取需要实际客户端绝对路径");
  const selectedLanguage = languageCode(language);
  if (!["722-v1", "727c-aghanim-v1"].includes(profile))
    throw Error("技能名称读取配置不属于固定白名单");
  await noLinks(root);
  const loose = new Map();
  for (const name of DEFINITIONS)
    loose.set(name, await looseDefinition(root, name));
  const wanted = new Set(LOCALIZATIONS);
  for (const [name, bytes] of loose) if (!bytes) wanted.add(name);
  const entries = await readEntries(root, wanted);
  const ids = new Set();
  for (const name of DEFINITIONS)
    for (const id of definitionIds(loose.get(name) || entries.get(name)))
      ids.add(id);
  if (ids.size > MAX_NAMES) throw Error("原版技能定义数量过多");
  const english = new Map(),
    schinese = new Map();
  for (const source of LOCALIZATIONS) {
    const target = source.endsWith("_schinese.txt") ? schinese : english;
    for (const [id, value] of names(
      entries.get(source),
      ids,
      profile === "727c-aghanim-v1",
    ))
      target.set(id, value);
  }
  const available = [
    ...new Set([...english.keys(), ...schinese.keys()]),
  ].sort();
  if (!available.length) throw Error("原版包没有可用的技能名称");
  const tokens = [],
    searchTokens = [];
  for (const id of available) {
    const display =
      (selectedLanguage === "schinese" && schinese.get(id)) ||
      english.get(id) ||
      id;
    const search = [
      ...new Set([english.get(id), schinese.get(id)].filter(Boolean)),
    ].join(" ");
    tokens.push("\t\t" + quote(id) + " " + quote(display));
    searchTokens.push("\t\t" + quote(id) + " " + quote(search));
  }
  const bytes = Buffer.from(
    '"ChronicleSkillLocalization"\n{\n\t"Tokens"\n\t{\n' +
      tokens.join("\n") +
      '\n\t}\n\t"SearchTokens"\n\t{\n' +
      searchTokens.join("\n") +
      "\n\t}\n}\n",
    "utf8",
  );
  if (bytes.length > MAX_OUTPUT) throw Error("临时技能名称索引过大");
  return bytes;
}

module.exports = { generate, TARGET };
