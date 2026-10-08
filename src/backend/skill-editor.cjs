const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { inside, noLinks, hash, readJson } = require("./files.cjs");
const { skillEditorProfile } = require("./event-catalog.cjs");
const {
  generate: generateLocalization,
  TARGET: LOCALIZATION_TARGET,
} = require("./skill-localization.cjs");

const TARGETS = Object.freeze([
  "game/dota/scripts/vscripts/chronicle_skill_editor_v1.lua",
  "game/dota/panorama/layout/custom_game/chronicle_ability_editor.vxml_c",
  "game/dota/panorama/scripts/custom_game/chronicle_ability_editor.vjs_c",
  "game/dota/panorama/styles/custom_game/chronicle_ability_editor.vcss_c",
]);
const LEASE_TARGETS = Object.freeze([...TARGETS, LOCALIZATION_TARGET]);
const LABYRINTH_TARGETS = Object.freeze([
  "game/dota/scripts/vscripts/chronicle_labyrinth_skill_editor_v1.lua",
  "game/dota/panorama/layout/custom_game/chronicle_labyrinth_ability_editor.vxml_c",
  "game/dota/panorama/scripts/custom_game/chronicle_labyrinth_ability_editor.vjs_c",
  "game/dota/panorama/styles/custom_game/chronicle_labyrinth_ability_editor.vcss_c",
]);
// Status becomes active before Labyrinth hero selection finishes. This fixed
// command queries the guarded Lua module; it cannot mutate gameplay or accept
// a caller-supplied Lua fragment (this build has no inline `script` command).
const LABYRINTH_CONTEXT_COMMAND = "chronicle_labyrinth_skill_context";
const PROFILES = Object.freeze({
  "722-v1": Object.freeze({
    id: "722-v1",
    folder: "7.22",
    build: 3504,
    targets: TARGETS,
    leaseTargets: LEASE_TARGETS,
    script: "chronicle_skill_editor_v1.lua",
    command: "chronicle_skill_panel open",
    marker: "CHRONICLE_SKILL",
    map: /^hero_demo_[a-z0-9_]+$/i,
    waiting: "waiting-demo",
    mapReason: "当前地图不是原生英雄试玩",
  }),
  "727c-aghanim-v1": Object.freeze({
    id: "727c-aghanim-v1",
    folder: "7.27c",
    build: 4397,
    targets: LABYRINTH_TARGETS,
    leaseTargets: Object.freeze([...LABYRINTH_TARGETS, LOCALIZATION_TARGET]),
    script: "chronicle_labyrinth_skill_editor_v1.lua",
    command: "chronicle_labyrinth_skill_panel open",
    marker: "CHRONICLE_LABYRINTH_SKILL",
    map: /^main$/i,
    waiting: "waiting-labyrinth",
    mapReason: "当前地图不是已登记的官方迷宫",
  }),
});
function profile(state) {
  return skillEditorProfile(state?.entry, state?.mode);
}
function fixedProfile(id) {
  if (!Object.hasOwn(PROFILES, id))
    throw Error("技能编辑器配置不属于固定白名单");
  return PROFILES[id];
}
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_WAIT_MS = 30 * 60 * 1000;
const IO_TIMEOUT_MS = 2000;
const SHA = /^[a-f0-9]{64}$/;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

function enabled(state) {
  return state?.type === "client" && state.host === false && !!profile(state);
}

function payloadDirectory(backendDirectory = __dirname, profileId = "722-v1") {
  let root = path.resolve(backendDirectory, "../..");
  if (root.endsWith(".asar")) root += ".unpacked";
  return path.join(
    root,
    "resources",
    "skill-editor",
    fixedProfile(profileId).folder,
  );
}

async function payloadFiles(directory, selectedProfile = PROFILES["722-v1"]) {
  await noLinks(directory);
  const manifestFile = inside(directory, "manifest.json");
  await noLinks(manifestFile);
  const manifest = await readJson(manifestFile);
  if (
    manifest?.schema !== 1 ||
    manifest.clientBuild !== selectedProfile.build ||
    (selectedProfile.id !== "722-v1" &&
      manifest.profile !== selectedProfile.id) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== selectedProfile.targets.length
  )
    throw Error("技能编辑器资源清单版本或文件数量无效");
  const seen = new Set(),
    result = [];
  for (const row of manifest.files) {
    if (
      !row ||
      !selectedProfile.targets.includes(row.target) ||
      seen.has(row.target) ||
      typeof row.source !== "string" ||
      row.source.includes("\\") ||
      row.source
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      path.posix.basename(row.source) !== path.posix.basename(row.target) ||
      !SHA.test(row.sha256 || "")
    )
      throw Error("技能编辑器资源超出唯一文件白名单");
    seen.add(row.target);
    const file = inside(directory, row.source);
    await noLinks(file);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw Error("技能编辑器资源不是普通文件");
    const bytes = await fs.readFile(file);
    if (digest(bytes) !== row.sha256) throw Error("技能编辑器资源指纹不匹配");
    result.push({ target: row.target, sha256: row.sha256, bytes });
  }
  return result;
}

async function verifyClient(state) {
  if (
    !enabled(state) ||
    !path.isAbsolute(state.root || "") ||
    !SHA.test(state.entry.sha || "")
  )
    throw Error("技能编辑器只允许已登记的单人客户端和地图入口");
  const selectedProfile = fixedProfile(profile(state));
  const inf = inside(state.root, "game/dota/steam.inf");
  await noLinks(inf);
  const bytes = await fs.readFile(inf);
  const versions = [
    ...bytes.toString("utf8").matchAll(/^\s*ClientVersion\s*=\s*(\d+)\s*$/gim),
  ];
  if (
    versions.length !== 1 ||
    versions[0][1] !== String(selectedProfile.build) ||
    digest(bytes) !== state.entry.sha
  )
    throw Error("技能编辑器客户端构建指纹或 ClientVersion 不匹配");
}

function validateLease(state) {
  const lease = state.skillEditorLease;
  if (!lease) return null;
  const selectedProfile =
    lease.clientBuild === 3504
      ? PROFILES["722-v1"]
      : lease.clientBuild === 4397 && lease.profile === "727c-aghanim-v1"
        ? PROFILES["727c-aghanim-v1"]
        : null;
  if (
    !path.isAbsolute(state.root || "") ||
    lease.schema !== 1 ||
    !selectedProfile ||
    !Array.isArray(lease.files) ||
    lease.files.length > selectedProfile.leaseTargets.length
  )
    throw Error("技能编辑器租约格式异常");
  const seen = new Set();
  for (const row of lease.files) {
    if (
      !row ||
      !SHA.test(row.sha256 || "") ||
      typeof row.owned !== "boolean" ||
      typeof row.restored !== "boolean" ||
      !selectedProfile.leaseTargets.some(
        (target) => inside(state.root, target) === row.path,
      ) ||
      seen.has(row.path)
    )
      throw Error("技能编辑器租约路径或指纹异常");
    seen.add(row.path);
  }
  return lease;
}

function createService(
  directory,
  localizationGenerator = generateLocalization,
) {
  async function prepare(state, save) {
    if (!enabled(state)) return;
    if (typeof save !== "function") throw Error("技能编辑器缺少租约保存接口");
    if (state.skillEditorLease)
      throw Error("技能编辑器租约已存在，不能重复安装");
    await verifyClient(state);
    const selectedProfile = fixedProfile(profile(state));
    const files = await payloadFiles(
      directory || payloadDirectory(__dirname, selectedProfile.id),
      selectedProfile,
    );
    // Native localization is UTF-16 and this build's Lua KV reader rejects it.
    // Derive only names from the user's local client; never distribute Valve text.
    const localization = await localizationGenerator(
      state.root,
      state.language,
      selectedProfile.id,
    );
    if (!Buffer.isBuffer(localization) || localization.length > 2 * 1024 * 1024)
      throw Error("技能名称索引无效或超过大小上限");
    files.push({
      target: LOCALIZATION_TARGET,
      sha256: digest(localization),
      bytes: localization,
    });
    // Validate all existing files before creating anything in the client.
    const planned = [];
    for (const file of files) {
      const target = inside(state.root, file.target);
      await noLinks(target);
      let owned = true;
      try {
        const stat = await fs.lstat(target);
        if (!stat.isFile() || (await hash(target)) !== file.sha256)
          throw Error("技能编辑器目标已存在不同内容，已保留原文件");
        owned = false;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      planned.push({ ...file, path: target, owned });
    }
    state.skillEditorLease = {
      schema: 1,
      clientBuild: selectedProfile.build,
      ...(selectedProfile.id !== "722-v1"
        ? { profile: selectedProfile.id }
        : {}),
      files: [],
      restored: false,
    };
    for (const file of planned) {
      const row = {
        path: file.path,
        sha256: file.sha256,
        owned: file.owned,
        restored: false,
      };
      state.skillEditorLease.files.push(row);
      // Persist ownership intent BEFORE exclusive creation, including crash windows.
      await save();
      if (!row.owned) continue;
      await fs.mkdir(path.dirname(file.path), { recursive: true });
      await noLinks(file.path);
      try {
        await fs.writeFile(file.path, file.bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // A concurrent creator owns this file, even if its content matches ours.
        row.owned = false;
        await save();
        await noLinks(file.path);
        if ((await hash(file.path)) !== row.sha256)
          throw Error("技能编辑器文件被同时创建，已保留外部内容");
      }
      await noLinks(file.path);
      if ((await hash(file.path)) !== row.sha256)
        throw Error("技能编辑器安装读回失败");
      await save();
    }
  }
  async function restore(state) {
    const lease = validateLease(state);
    if (!lease || lease.restored) return;
    const errors = [];
    for (const row of lease.files) {
      if (row.restored) continue;
      try {
        await noLinks(row.path);
        if (row.owned) {
          let stat;
          try {
            stat = await fs.lstat(row.path);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          if (stat) {
            if (!stat.isFile() || (await hash(row.path)) !== row.sha256) {
              row.externalChangePreserved = true;
              row.restored = true;
              errors.push("技能编辑器新增文件被外部修改，已保留内容");
              continue;
            }
            await noLinks(row.path);
            if ((await hash(row.path)) !== row.sha256)
              throw Error("技能编辑器文件在恢复前变化，已保留");
            await fs.unlink(row.path);
          }
        }
        row.restored = true;
      } catch (error) {
        errors.push(error.message);
      }
    }
    lease.restored = lease.files.every((row) => row.restored);
    if (errors.length) throw Error(errors.join("；"));
  }
  return { prepare, restore };
}

function plainText(text) {
  return text
    .replace(/\xff\xfa[\s\S]*?(?:\xff\xf0|$)/g, "")
    .replace(/\xff[\xfb-\xfe][\s\S]/g, "")
    .replace(/\xff[\xf0-\xfa\xff]/g, "");
}

function parseStatus(input, profileId = "722-v1") {
  const selectedProfile = fixedProfile(profileId);
  if (
    typeof input !== "string" ||
    Buffer.byteLength(input, "latin1") > MAX_REPLY_BYTES
  )
    throw Error("技能编辑器控制回复无效或超过安全上限");
  const text = plainText(input),
    lines = text.split(/\r?\n/);
  const matches = (pattern) =>
    lines.map((line) => pattern.exec(line)).filter(Boolean);
  const ends = matches(/^\s*#end\s*$/i);
  const counts = matches(
    /^\s*players\s*:\s*(\d+)\s+humans?\s*,\s*(\d+)\s+bots?\b/i,
  );
  const clients = matches(/^\s*Client\s*:\s*Connected\s*\[([^\]]+)\]/i);
  const maps = matches(
    /^\s*loaded spawngroup\s*\([^\r\n)]*\)\s*:\s*SV\s*:\s*\[\s*\d+\s*:\s*([a-z0-9_]+)\s*\|/i,
  );
  const complete = ends.length === 1 && counts.length === 1;
  const humans = counts.length === 1 ? Number(counts[0][1]) : null;
  const bots = counts.length === 1 ? Number(counts[0][2]) : null;
  // The native endpoint counter changes between maps/process starts; :1 is
  // still engine loopback. No IP, hostname or arbitrary suffix is accepted.
  const localEndpoint =
    clients.length === 1
      ? /^loopback(?::(\d{1,5}))?$/i.exec(clients[0][1])
      : null;
  const localClient = Boolean(
    localEndpoint &&
    (localEndpoint[1] === undefined || Number(localEndpoint[1]) <= 65535),
  );
  // Client (CL) view groups are never evidence of the server's map.
  const labyrinth = profileId === "727c-aghanim-v1";
  // Labyrinth loads each combat room as an additional SV spawngroup. Only its
  // unique root group 1 / server slot 1 establishes the map; room groups never
  // become a new map or reset the editor lifetime. The 7.22 parser stays strict.
  const nativeGroups = labyrinth
    ? matches(
        /^\s*loaded spawngroup\s*\(\s*(\d+)\s*\)\s*:\s*SV\s*:\s*\[\s*(\d+)\s*:\s*([a-z0-9_]+|<empty>)\s*\|/i,
      )
    : [];
  const rootGroups = nativeGroups.filter(
    (match) => match[1] === "1" || match[2] === "1",
  );
  const validRoot =
    rootGroups.length === 1 &&
    rootGroups[0][1] === "1" &&
    rootGroups[0][2] === "1";
  const rootMap = validRoot ? rootGroups[0][3].toLowerCase() : null;
  const serverMaps = labyrinth
    ? rootMap && rootMap !== "<empty>"
      ? [rootMap]
      : []
    : [...new Set(maps.map((match) => match[1]))];
  const map = serverMaps.length === 1 ? serverMaps[0] : null;
  const emptyMap = labyrinth
    ? rootMap === "<empty>"
    : /^\s*loaded spawngroup\s*\([^\r\n)]*\)\s*:\s*SV\s*:\s*\[\s*\d+\s*:\s*<empty>\s*\|/im.test(
        text,
      );
  const headerIndexes = lines.flatMap((line, index) =>
    /^\s*id\s+time\s+ping\s+loss\s+state\s+rate\s+name\s*$/i.test(line)
      ? [index]
      : [],
  );
  const playerRows = [];
  let invalidPlayerSection = false;
  if (headerIndexes.length === 1) {
    for (let index = headerIndexes[0] + 1; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim()) continue;
      if (/^\s*(?:#end\s*$|GameState\s*:)/i.test(line)) break;
      const row =
        /^\s*(\d+)\s+\d+:\d+(?::\d+)?\s+\d+\s+\d+\s+(\w+)\s+\d+\s+(?:"[^"\r\n]*"|'[^'\r\n]*')\s*$/i.exec(
          line,
        );
      if (!row) {
        invalidPlayerSection = true;
        break;
      }
      playerRows.push(row);
    }
  }
  const activePlayer =
    playerRows.length === 1 && playerRows[0][2].toLowerCase() === "active";
  let unsafeReason = null;
  if (
    complete &&
    ((humans !== null && humans > 1) || (bots !== null && bots > 0))
  )
    unsafeReason = "仅允许单人且没有机器人";
  // Native 2019 dashboards can expose 1 human and a transitional client header
  // while the server group has <empty> instead of a map. No validated server
  // map means waiting, never permission to bootstrap or evidence of a room.
  if (complete && map && humans > 0 && clients.length && !localClient)
    unsafeReason = "玩家连接不是本机 loopback";
  if (complete && serverMaps.length > 1) unsafeReason = "地图状态存在歧义";
  if (
    complete &&
    labyrinth &&
    (nativeGroups.length || maps.length) &&
    !validRoot
  )
    unsafeReason = "迷宫根地图缺失或存在歧义";
  if (complete && map && !selectedProfile.map.test(map))
    unsafeReason = selectedProfile.mapReason;
  if (complete && headerIndexes.length > 1) unsafeReason = "玩家状态表存在歧义";
  if (complete && playerRows.length > 1) unsafeReason = "检测到多个玩家行";
  if (complete && invalidPlayerSection)
    unsafeReason = "玩家状态表存在非原生玩家行";
  return {
    complete,
    humans,
    bots,
    localClient,
    map,
    activePlayer,
    unsafeReason,
    outsideDemo:
      complete && (emptyMap || /^\s*Server\s*:\s*Not running\b/im.test(text)),
    dashboardReady:
      complete &&
      !unsafeReason &&
      emptyMap &&
      !map &&
      humans === 1 &&
      bots === 0 &&
      localClient &&
      activePlayer &&
      /^\s*Server\s*:\s*Running\b/im.test(text) &&
      /^\s*@\s*Current\s*:\s*game\s*$/im.test(text),
    ready:
      complete &&
      !unsafeReason &&
      humans === 1 &&
      bots === 0 &&
      localClient &&
      selectedProfile.map.test(map || "") &&
      activePlayer &&
      /^\s*Server\s*:\s*Running\b/im.test(text) &&
      /^\s*@\s*Current\s*:\s*game\s*$/im.test(text),
  };
}

async function waitAndLoad({
  profile: profileId = "722-v1",
  port,
  password,
  isOwned,
  isStopping,
  onPhase = async () => {},
  onReady = async () => {},
  continuous = false,
  timeoutMs = MAX_WAIT_MS,
  connect = (options) => net.connect(options),
  sleep = delay,
}) {
  const selectedProfile = fixedProfile(profileId);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    typeof password !== "string" ||
    !/^[a-f\d]{48,256}$/i.test(password) ||
    ![isOwned, isStopping, onPhase, onReady, connect, sleep].every(
      (fn) => typeof fn === "function",
    ) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_WAIT_MS ||
    typeof continuous !== "boolean"
  )
    throw Error("技能编辑器本地控制初始化参数无效");
  let deadline = Date.now() + timeoutMs,
    activeLifetime = false;
  let socket,
    connected = false,
    buffer = "",
    lineTail = "",
    replyMarker,
    replyMatched = false,
    streamError,
    bootstrapping = false,
    socketError,
    finished = false,
    lastPhase;
  let cancel;
  const cancellation = new Promise((_, reject) => {
    cancel = reject;
  });
  cancellation.catch(() => {});
  const cancelled = () =>
    Object.assign(Error("已停止技能编辑器初始化"), {
      code: "SKILL_EDITOR_CANCELLED",
    });
  const remaining = () => {
    // timeoutMs bounds waiting for a demo, not a user's active practice time.
    if (activeLifetime) return MAX_WAIT_MS;
    const ms = deadline - Date.now();
    if (ms <= 0) throw Error("等待原生英雄试玩或技能面板超时");
    return ms;
  };
  const bounded = async (operation, limit, message) => {
    let timer;
    try {
      return await Promise.race([
        operation,
        cancellation,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error(message)),
            Math.min(limit, remaining()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  // This independent watcher can cancel an outstanding socket/ownership wait.
  const watcher = (async () => {
    while (!finished) {
      try {
        const stopping = await bounded(
          Promise.resolve().then(isStopping),
          5000,
          "检查技能编辑器停止请求超时",
        );
        if (stopping) {
          cancel(cancelled());
          return;
        }
        await bounded(delay(50), 200, "检查技能编辑器停止请求超时");
      } catch (error) {
        if (!finished) cancel(error);
        return;
      }
    }
  })();
  const guard = async () => {
    remaining();
    if (
      await bounded(
        Promise.resolve().then(isStopping),
        10000,
        "检查停止请求超时",
      )
    )
      throw cancelled();
    if (
      !(await bounded(
        Promise.resolve().then(() => isOwned({ connected })),
        10000,
        "确认本机客户端身份超时",
      ))
    ) {
      if (
        await bounded(
          Promise.resolve().then(isStopping),
          10000,
          "检查停止请求超时",
        )
      )
        throw cancelled();
      throw Error("游戏进程或本地控制端口不再属于本程序");
    }
    if (
      await bounded(
        Promise.resolve().then(isStopping),
        10000,
        "检查停止请求超时",
      )
    )
      throw cancelled();
  };
  const phase = async (value) => {
    if (value === lastPhase) return;
    await bounded(
      Promise.resolve().then(() => onPhase(value)),
      IO_TIMEOUT_MS,
      "记录技能编辑器阶段超时",
    );
    lastPhase = value;
  };
  const pause = (ms) =>
    bounded(
      Promise.resolve().then(() => sleep(Math.min(ms, remaining()))),
      Math.min(ms + 250, IO_TIMEOUT_MS + 500),
      "等待技能编辑器回复超时",
    );
  const detectError = (text) => {
    if (
      /^\s*(?:bad\s+password|not\s+authenticated|authentication\s+failed|password\s+incorrect)\b/im.test(
        text,
      )
    )
      return Error("本地控制口令认证失败");
    if (
      /^\s*(?:\[VScript\]\s*)?Unknown command\b/im.test(text) ||
      new RegExp(
        "(?:^|\\n)\\s*(?:\\[VScript\\]\\s*)?(?:Lua (?:error|runtime error)|Script Runtime Error|" +
          selectedProfile.marker +
          "_ERROR)\\b",
        "i",
      ).test(text) ||
      (bootstrapping &&
        new RegExp(
          "^\\s*(?:\\[VScript\\]\\s*)?" +
            selectedProfile.marker +
            "_REFUSED\\b",
          "im",
        ).test(text)) ||
      /(?:^|\n)\s*(?:\[VScript\]\s*)?(?:[^\r\n]*[\\/])?[^\r\n:]+\.lua:\d+:\s*\S/i.test(
        text,
      )
    )
      return Error("原生客户端拒绝技能编辑器命令或 Lua 加载失败");
    return null;
  };
  const scanLine = (raw) => {
    const text = plainText(raw);
    streamError ||= detectError(text);
    if (replyMarker && replyMarker.test(text)) replyMatched = true;
  };
  const receive = (chunk, candidate) => {
    // A native map transition can stream hundreds of KiB of short log lines.
    // Retain only a 64 KiB ring; scan every line before discarding old output.
    // Neither a success marker nor an authentication/Lua failure can be evicted.
    for (let offset = 0; offset < chunk.length; offset += 4096) {
      const part = chunk.subarray(offset, offset + 4096).toString("latin1");
      buffer = (buffer + part).slice(-MAX_REPLY_BYTES);
      let cursor = 0,
        newline;
      while ((newline = part.indexOf("\n", cursor)) >= 0) {
        const segment = part.slice(cursor, newline);
        if (lineTail.length + segment.length > MAX_REPLY_BYTES) {
          streamError = Error("本地控制单行超过 64 KiB 安全上限");
          candidate.destroy();
          return;
        }
        scanLine(lineTail + segment);
        lineTail = "";
        cursor = newline + 1;
      }
      const remainder = part.slice(cursor);
      if (lineTail.length + remainder.length > MAX_REPLY_BYTES) {
        streamError = Error("本地控制单行超过 64 KiB 安全上限");
        candidate.destroy();
        return;
      }
      lineTail += remainder;
      streamError ||= detectError(plainText(lineTail));
    }
  };
  const check = () => {
    if (streamError) throw streamError;
    if (socketError) throw socketError;
    // The first retained ring character may be in the middle of a log line.
    // Only the independent full-line scanner can authenticate error prefixes.
    return plainText(buffer);
  };
  async function open() {
    for (;;) {
      await guard();
      buffer = "";
      lineTail = "";
      replyMarker = undefined;
      replyMatched = false;
      streamError = undefined;
      socketError = undefined;
      let established = false;
      try {
        const candidate = connect({ host: "127.0.0.1", port });
        socket = candidate;
        candidate.on("data", (chunk) => {
          if (socket !== candidate) return;
          receive(chunk, candidate);
        });
        candidate.on("error", () => {
          if (socket === candidate)
            socketError ||= Error("本地控制连接发生错误");
        });
        candidate.on("close", () => {
          if (socket === candidate) socketError ||= Error("本地控制连接已关闭");
        });
        await bounded(
          new Promise((resolve, reject) => {
            candidate.once("connect", resolve);
            candidate.once("error", reject);
            candidate.once("close", () => reject(Error("本地控制连接已关闭")));
          }),
          IO_TIMEOUT_MS,
          "连接本地控制端口超时",
        );
        established = true;
        connected = true;
        check();
        await guard();
        return;
      } catch (error) {
        socket?.destroy();
        if (established || error.code === "SKILL_EDITOR_CANCELLED") throw error;
        await pause(100);
      }
    }
  }
  async function send(
    command,
    marker,
    allowPartial = false,
    replyTimeoutMs = IO_TIMEOUT_MS,
  ) {
    await guard();
    check();
    buffer = "";
    replyMarker = marker;
    replyMatched = false;
    const started = Date.now(),
      responseDeadline = Math.min(deadline, started + replyTimeoutMs);
    await bounded(
      new Promise((resolve, reject) =>
        socket.write(command + "\n", (error) =>
          error ? reject(Error("发送本地控制命令失败")) : resolve(),
        ),
      ),
      IO_TIMEOUT_MS,
      "发送本地控制命令超时",
    );
    for (;;) {
      await guard();
      const text = check();
      if (marker && replyMatched) return text;
      if (!marker && Date.now() - started >= 120) return text;
      if (Date.now() >= responseDeadline) {
        if (allowPartial) return text;
        throw Error("本地控制命令未返回预期成功标记");
      }
      await pause(20);
    }
  }
  try {
    await phase(selectedProfile.waiting);
    await open();
    await send("PASS " + password);
    let status,
      enteredMap = null,
      loadedMap = null,
      dashboardSince = null,
      launchRequested = false;
    for (;;) {
      await guard();
      status = parseStatus(
        await send("status", /^\s*#end\s*$/im, true),
        profileId,
      );
      if (status.unsafeReason)
        throw Error("技能编辑器未加载：" + status.unsafeReason);
      if (
        profileId === "727c-aghanim-v1" &&
        !launchRequested &&
        !status.ready
      ) {
        if (status.dashboardReady) {
          dashboardSince ??= Date.now();
          if (Date.now() - dashboardSince >= 3000) {
            await send("dota_launch_custom_game aghanim main");
            launchRequested = true;
          }
        } else dashboardSince = null;
        await pause(1000);
        continue;
      }
      if ((enteredMap || loadedMap) && status.outsideDemo) {
        enteredMap = null;
        loadedMap = null;
        activeLifetime = false;
        deadline = Date.now() + timeoutMs;
        await phase(selectedProfile.waiting);
      }
      if (status.ready) {
        if (enteredMap !== status.map) {
          if (loadedMap !== status.map) {
            deadline = Date.now() + timeoutMs;
            activeLifetime = false;
            bootstrapping = true;
            await phase("loading");
            await send("sv_cheats 1");
            await send(
              "script_reload_code " + selectedProfile.script,
              new RegExp(
                "^\\s*(?:\\[VScript\\]\\s*)?" +
                  selectedProfile.marker +
                  "_EDITOR_LOADED\\b",
                "im",
              ),
              false,
              15000,
            );
            loadedMap = status.map;
          }
          if (profileId === "727c-aghanim-v1") {
            const context = await send(
              LABYRINTH_CONTEXT_COMMAND,
              /^\s*(?:\[VScript\]\s*)?CHRONICLE_LABYRINTH_SKILL_CONTEXT_(?:READY|WAIT)\b/im,
            );
            if (
              !/^\s*(?:\[VScript\]\s*)?CHRONICLE_LABYRINTH_SKILL_CONTEXT_READY\b/im.test(
                context,
              )
            ) {
              bootstrapping = false;
              await phase(selectedProfile.waiting);
              await pause(500);
              continue;
            }
          }
          bootstrapping = true;
          await phase("loading");
          await send(
            selectedProfile.command,
            new RegExp(
              "^\\s*(?:\\[VScript\\]\\s*)?" +
                selectedProfile.marker +
                "_EDITOR_UI_READY\\b",
              "im",
            ),
            false,
            15000,
          );
          await guard();
          await phase("ready");
          await bounded(
            Promise.resolve().then(onReady),
            IO_TIMEOUT_MS,
            "记录技能面板就绪超时",
          );
          enteredMap = status.map;
          bootstrapping = false;
          if (!continuous)
            return {
              loaded: true,
              panelRequested: true,
              uiReady: true,
              map: status.map,
            };
          activeLifetime = true;
        }
      }
      await pause(continuous && enteredMap ? 2000 : 150);
    }
  } finally {
    finished = true;
    cancel(cancelled());
    socket?.destroy();
    // Do not wait for a hung external ownership callback after cancellation.
    watcher.catch(() => {});
  }
}

const service = createService();
module.exports = {
  profile,
  enabled,
  prepare: service.prepare,
  restore: service.restore,
  waitAndLoad,
  _forTesting: {
    createService,
    payloadDirectory,
    parseStatus,
    TARGETS,
    LABYRINTH_TARGETS,
    LABYRINTH_CONTEXT_COMMAND,
  },
};
