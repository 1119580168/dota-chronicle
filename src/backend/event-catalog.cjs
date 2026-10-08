const path = require("node:path");

function allowsSkillEditor(entry) {
  return (
    entry?.id === "7.22" &&
    entry.skillEditor === "722-v1" &&
    entry.playable === true &&
    entry.source2 === true &&
    !entry.prototype &&
    String(entry.build) === "3504"
  );
}

function allowsLabyrinthSkillEditor(entry, event) {
  return (
    entry?.id === "7.27c" &&
    entry.playable === true &&
    entry.source2 === true &&
    !entry.prototype &&
    String(entry.build) === "4397" &&
    event?.id === "aghanim1" &&
    event.version === entry.id &&
    event.category === "official" &&
    event.addon === "aghanim" &&
    event.map === "main" &&
    event.skillEditor === "727c-aghanim-v1" &&
    !event.launchDisabledReason
  );
}

function skillEditorProfile(entry, mode) {
  if (mode === "skills" && allowsSkillEditor(entry)) return "722-v1";
  if (
    mode === "aghanim1-skills" &&
    allowsLabyrinthSkillEditor(
      entry,
      entry?.events?.find((event) => event.id === "aghanim1"),
    )
  )
    return "727c-aghanim-v1";
  return null;
}

function launchEvent(entry, mode) {
  return entry.events.find(
    (event) => event.id === (mode === "aghanim1-skills" ? "aghanim1" : mode),
  );
}

function assertSkillEditorMode(
  entry,
  mode,
  { host = false, type = "client" } = {},
) {
  if (
    ["skills", "aghanim1-skills"].includes(mode) &&
    (!skillEditorProfile(entry, mode) || host || type !== "client")
  )
    throw Error("技能编辑器仅支持已登记的本机单人试玩或 7.27c 迷宫入口");
}

// A repeated community id is one immutable package with separate client routes.
// Gameplay validation and launch restrictions belong to each individual route.
function validateEventCatalog(catalog) {
  if (!Array.isArray(catalog?.entries)) throw Error("客户端白名单格式错误");
  const clients = new Set(),
    events = new Map();
  for (const entry of catalog.entries) {
    if (typeof entry.id !== "string" || !entry.id || clients.has(entry.id))
      throw Error("客户端白名单存在无效或重复版本");
    clients.add(entry.id);
    if (entry.skillEditor !== undefined && !allowsSkillEditor(entry))
      throw Error("技能编辑器只能登记在 7.22 / build 3504 白名单客户端");
    if (!Array.isArray(entry.events)) throw Error("地图白名单格式错误");
    const own = new Set();
    for (const event of entry.events) {
      if (
        typeof event.id !== "string" ||
        !event.id ||
        ["menu", "bots", "join", "skills", "aghanim1-skills"].includes(
          event.id,
        ) ||
        own.has(event.id)
      )
        throw Error("同一客户端的地图白名单存在无效或重复入口");
      own.add(event.id);
      if (event.version !== entry.id)
        throw Error("地图入口版本与所属客户端不一致：" + event.id);
      if (
        event.skillEditor !== undefined &&
        !allowsLabyrinthSkillEditor(entry, event)
      )
        throw Error(
          "活动技能编辑器只能登记在 7.27c / build 4397 的官方迷宫入口",
        );
      if (
        event.launchDisabledReason !== undefined &&
        typeof event.launchDisabledReason !== "string"
      )
        throw Error("地图禁用原因格式错误：" + event.id);
      if (
        event.requiresCheats !== undefined &&
        typeof event.requiresCheats !== "boolean"
      )
        throw Error("地图工具模式格式错误：" + event.id);
      if (event.requiresCheats === true && event.category !== "community")
        throw Error("工具模式仅允许用于明确登记的游廊地图");
      if (
        event.category === "community" &&
        (!/^[a-f0-9]{64}$/.test(event.packageSha || "") ||
          !/^[0-9]{1,20}$/.test(event.workshopId || "") ||
          !/^[a-z0-9_-]+$/i.test(event.map || ""))
      )
        throw Error("游廊原包身份或地图名称无效：" + event.id);
      const group = events.get(event.id) || [];
      group.push({ entry, event });
      events.set(event.id, group);
    }
  }
  for (const [id, group] of events) {
    if (group.length < 2) continue;
    const first = group[0].event;
    if (
      group.some(
        ({ entry, event }) =>
          event.category !== "community" ||
          entry.playable !== true ||
          entry.source2 !== true ||
          entry.prototype ||
          event.packageSha !== first.packageSha ||
          event.workshopId !== first.workshopId ||
          event.map !== first.map,
      )
    )
      throw Error(
        "跨客户端地图必须使用同一游廊原包和可运行的 Source 2 白名单：" + id,
      );
  }
  return events;
}

function catalogEntry(catalog, id) {
  validateEventCatalog(catalog);
  const entry = catalog.entries.find((entry) => entry.id === id);
  if (!entry) throw Error("未知版本，不属于客户端白名单");
  return entry;
}

function packageEvent(catalog, id) {
  const group = validateEventCatalog(catalog).get(id);
  const event = group?.[0]?.event;
  if (event?.category !== "community") throw Error("未知游廊包");
  return event;
}

function assertEventEnabled(event) {
  if (event?.launchDisabledReason?.trim())
    throw Error(
      "此地图在所选客户端已禁用：" + event.launchDisabledReason.trim(),
    );
}

function trustedEntryForSession(catalog, session) {
  // The queued entry copy is a recovery record, not permission for a new launch.
  const entry = catalogEntry(catalog, session?.entry?.id);
  const mode = session.mode ?? "menu";
  assertSkillEditorMode(entry, mode, session);
  let event;
  if (mode === "join") {
    const joinMode = session.joinMode === undefined ? "bots" : session.joinMode;
    if (joinMode !== "bots") {
      event = entry.events.find((event) => event.id === joinMode);
      if (!event) throw Error("加入的地图不属于这个版本");
    }
  } else if (!["menu", "bots", "skills"].includes(mode)) {
    event = launchEvent(entry, mode);
    if (!event) throw Error("地图不属于这个版本");
  }
  assertEventEnabled(event);
  return entry;
}

function catalogFile(backendDirectory = __dirname) {
  const root = path.resolve(backendDirectory, "../..");
  // Guardian code is unpacked, while the authoring whitelist stays in app.asar.
  return path.join(
    root.endsWith(".asar.unpacked") ? root.slice(0, -".unpacked".length) : root,
    "resources/catalog.json",
  );
}

module.exports = {
  allowsSkillEditor,
  allowsLabyrinthSkillEditor,
  skillEditorProfile,
  launchEvent,
  assertSkillEditorMode,
  validateEventCatalog,
  catalogEntry,
  packageEvent,
  assertEventEnabled,
  trustedEntryForSession,
  catalogFile,
};
