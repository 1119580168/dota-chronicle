const api = window.chronicle;
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name, cls = "") => `<i data-lucide="${name}" class="${cls}"></i>`;
const activeStages = [
  "queued",
  "starting",
  "loading",
  "running",
  "stopping",
  "restoring",
  "recovery-required",
];
const stageText = {
  queued: "等待启动",
  starting: "准备运行",
  loading: "正在加载",
  running: "正在运行",
  stopping: "正在结束",
  restoring: "恢复临时设置",
  finished: "已结束",
  failed: "启动失败",
  "recovery-required": "需要恢复检查",
};
const skillEditorPhaseText = {
  "waiting-demo": "请在游戏主菜单进入任意英雄的原生试玩",
  "waiting-labyrinth": "请选择并锁定迷宫英雄，技能面板会自动载入",
  loading: "正在加载技能编辑器",
  ready: "技能工具已加载，面板已请求打开",
  error: "技能编辑器未载入，游戏仍可继续使用",
};
let store,
  view = "timeline",
  selected = "7.19",
  selectedEvent = null,
  selectedHistory = "patch-7.19",
  filter = "all",
  query = "",
  draft = null,
  roomVersion = "7.32",
  roomMode = "bots",
  toastTimer,
  launchSettingsBusy = false,
  lastStages = new Map();
let searchComposing = false;
const eventClientSelections = new Map();
const entry = () =>
  store.entries.find((e) => e.id === selected) || store.entries[0];
const eventRuntimeChoices = (id) =>
  store.entries.flatMap((client) => {
    const event = client.events.find((item) => item.id === id);
    return event ? [{ client, event }] : [];
  });
const allEvents = () => {
  const groups = new Map();
  for (const client of store.entries) {
    for (const event of client.events) {
      if (!groups.has(event.id)) groups.set(event.id, []);
      groups.get(event.id).push({ client, event });
    }
  }
  return [...groups.values()].map((runtimeChoices) => {
    const preferred = runtimeChoices[0].event.defaultVersion,
      primary =
        runtimeChoices.find((choice) => choice.client.id === preferred) ||
        runtimeChoices[0];
    return { ...primary.event, runtimeChoices };
  });
};
function eventClientId(event, preferred) {
  const choices = eventRuntimeChoices(event.id);
  return (
    [
      preferred,
      eventClientSelections.get(event.id),
      event.defaultVersion,
      event.version,
    ].find((id) => choices.some((choice) => choice.client.id === id)) ||
    choices[0]?.client.id
  );
}
function eventClientSelector(event) {
  const choices = eventRuntimeChoices(event.id);
  if (choices.length < 2) return "";
  return `<label class="field language-inline"><span>启动客户端</span><select data-event-client="${esc(event.id)}" aria-label="地图启动客户端" ${launchSettingsBusy ? "disabled" : ""}>${choices.map(({ client, event: variant }) => `<option value="${esc(client.id)}" ${client.id === selected ? "selected" : ""}>${esc(client.version)} · ${esc(!client.installed ? "未绑定" : variant.launchDisabledReason ? "已发现不兼容" : variant.verified || "待基础试玩")}</option>`).join("")}</select></label>`;
}
const roomEvent = (e) => e.events.find((event) => event.id === roomMode);
const roomCanLaunch = (e) =>
  e.installed &&
  !launchSettingsBusy &&
  (roomMode === "bots" ||
    (!!roomEvent(e)?.available && !roomEvent(e)?.launchDisabledReason));
const clientIdle = () =>
  !store.sessions.some(
    (s) => s.type !== "dedicated" && activeStages.includes(s.stage),
  );
const canPlay = (e) => e.installed && clientIdle() && !launchSettingsBusy;
const canMenu = (e) => e.menuAvailable && clientIdle() && !launchSettingsBusy;
const hasSkillEditor = (e) =>
  e.id === "7.22" && e.skillEditor === "722-v1" && e.build === "3504";
const canSkills = (e) => hasSkillEditor(e) && canPlay(e);
const hasLabyrinthSkills = (e, event) =>
  e.id === "7.27c" &&
  e.build === "4397" &&
  e.source2 === true &&
  e.playable === true &&
  event?.id === "aghanim1" &&
  event.addon === "aghanim" &&
  event.map === "main" &&
  event.category === "official" &&
  event.skillEditor === "727c-aghanim-v1" &&
  !event.launchDisabledReason;
const canLabyrinthSkills = (e, event) =>
  hasLabyrinthSkills(e, event) && event.available && canPlay(e);
function languageSelector(e, cls = "launch-options") {
  if (!e.menuAvailable || !e.languages?.length) return "";
  return `<label class="field ${cls}" title="${esc(e.languageNote)}下次启动生效。"><span>界面语言</span><select data-launch-language="${esc(e.id)}" aria-label="游戏界面语言" ${launchSettingsBusy ? "disabled" : ""}>${e.languages.map((l) => `<option value="${l.code}" ${l.code === e.language ? "selected" : ""}>${esc(l.label)}</option>`).join("")}</select>${cls === "full" ? `<small>${esc(e.languageNote)}下次启动生效。</small>` : ""}</label>`;
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 8000);
}
function badge(text, type = "") {
  return `<span class="badge ${type}">${esc(text)}</span>`;
}
function sidebar() {
  return `<aside class="sidebar"><div class="brand"><svg class="brand-symbol" viewBox="0 0 32 40" fill="none"><path d="M5 5v31M14 6h17M14 20h17M14 35h10" stroke="currentColor" stroke-width="2"/><circle cx="5" cy="6" r="3" fill="currentColor"/><circle cx="5" cy="20" r="2" fill="currentColor"/><circle cx="5" cy="35" r="2" fill="currentColor"/></svg><div><div class="display brand-name">CHRONICLE</div><small>DOTA 2 编年馆</small></div></div><div class="sidebar-divider"></div><nav class="navigation" aria-label="主导航">${[
    [
      "timeline",
      "历史时间线",
      "history",
      String(store.history.entries.length),
      "版本与时代",
    ],
    [
      "rpg",
      "RPG 档案",
      "swords",
      String(allEvents().length).padStart(2, "0"),
      "官方活动 / 游廊",
    ],
    ["room", "本地房间", "network", "", "创建与连接"],
    ["library", "我的版本库", "folder-archive", "", "绑定与归档"],
  ]
    .map(
      ([id, label, i, count, description]) =>
        `<button class="nav ${view === id ? "active" : ""}" data-view="${id}" data-testid="nav-${id}" aria-current="${view === id ? "page" : "false"}">${icon(i)}<span class="nav-label">${label}<span class="nav-description">${description}</span></span><small>${count}</small></button>`,
    )
    .join(
      "",
    )}</nav><div class="sidebar-note"><strong><span class="offline-dot"></span>离线档案馆</strong><span>游戏需本机客户端与 Steam</span><div class="sidebar-license">源码公开 · 非商业使用<small>PolyForm Noncommercial 1.0.0</small></div><span class="display">VERSION ${esc(store.launcherVersion)} / WINDOWS</span></div></aside>`;
}
function mediaCover(m, cls = "", fallback = "ARCHIVE") {
  return `<div class="media-cover ${cls}">${m?.cover ? `<img src="${esc(m.cover.url)}" alt="${esc(m.cover.title)}" loading="lazy">` : `<span class="cover-fallback display">${esc(fallback)}</span>`}</div>`;
}
function inspectorCover(m, fallback) {
  const cover = mediaCover(m, "inspector-cover", fallback);
  return m?.cover
    ? `<button class="cover-open" data-media="${esc(m.cover.id)}" aria-label="查看封面原图">${cover}<span class="cover-zoom">${icon("expand")}</span></button>`
    : cover;
}
function mediaGallery(owner) {
  if (!owner.media) return "";
  const m = owner.media || { shots: {}, videos: [] };
  const shotKinds = owner.category
    ? [["gameplay", "地图实景"]]
    : owner.playable === false
      ? [["menu", "主界面"]]
      : [
          ["menu", "主界面"],
          ["selection", "英雄选择"],
          ["gameplay", "游戏画面"],
        ];
  return `<section class="media-gallery"><div class="section-label">时代影像 <small>本机素材</small></div><div class="shot-grid">${shotKinds.map(([kind, label]) => `<button class="shot ${m.shots?.[kind] ? "" : "missing"}" ${m.shots?.[kind] ? `data-media="${m.shots[kind].id}"` : `data-import-media="${kind}" data-media-owner="${esc(owner.id)}"`} aria-label="${label}${m.shots?.[kind] ? "，展开原图" : "，添加截图"}">${m.shots?.[kind] ? `<img src="${esc(m.shots[kind].url)}" alt="${label}" loading="lazy">` : icon("image-plus")}<span>${label}</span></button>`).join("")}</div>${(m.videos || []).length ? `<div class="video-list">${m.videos.map((v) => `<div class="video-item"><button class="video-link" data-media="${v.id}">${icon("film")}<span>${esc(v.title)}</span>${icon("play")}</button><button class="icon-button" data-media-fullscreen="${v.id}" title="全屏播放" aria-label="全屏播放 ${esc(v.title)}">${icon("maximize")}</button></div>`).join("")}</div>` : `<p class="hint media-note">暂无宣传动画</p>`}<details class="media-tools" data-disclosure-key="media-tools"><summary>管理影像</summary><div class="media-imports">${[
    ["cover", "封面"],
    ["menu", "主界面"],
    ["selection", "英雄选择"],
    ["gameplay", "游戏画面"],
    ["video", "WebM 视频"],
  ]
    .filter(
      ([kind]) =>
        owner.playable !== false || !["selection", "gameplay"].includes(kind),
    )
    .map(
      ([kind, label]) =>
        `<button class="button small ghost" data-import-media="${kind}" data-media-owner="${esc(owner.id)}">${icon("plus")}${label}</button>`,
    )
    .join("")}</div></details></section>`;
}
function findMedia(id) {
  return store.entries
    .flatMap((e) => [e, ...e.events])
    .flatMap((e) => [
      e.media?.cover,
      ...Object.values(e.media?.shots || {}),
      ...(e.media?.videos || []),
    ])
    .find((m) => m?.id === id);
}
async function showMedia(id, fullscreen = false) {
  const m = findMedia(id);
  if (!m) return;
  const dialog = $("#mediaViewer");
  $("#mediaViewerBody").innerHTML =
    `<header class="viewer-head"><div><span class="eyebrow">本机影像</span><h2>${esc(m.title)}</h2></div><div class="viewer-actions"><button class="button small ghost" data-action="mediaFullscreen" aria-label="全屏播放">${icon("maximize")}<span>全屏</span></button><button class="icon-button" data-action="closeMedia" aria-label="关闭影像">${icon("x")}</button></div></header><div class="viewer-stage">${m.type.startsWith("video/") ? `<video class="viewer-image" src="${esc(m.url)}" controls preload="metadata" playsinline></video>` : `<img class="viewer-image" src="${esc(m.url)}" alt="${esc(m.title)}">`}</div><footer class="viewer-footer"><p class="viewer-source">${esc(m.source)}${m.build ? ` · 构建 ${esc(m.build)}` : ""}</p><span class="fullscreen-hint">Esc 退出全屏</span></footer>`;
  window.lucide.createIcons();
  if (!dialog.open) dialog.showModal();
  const player = dialog.querySelector("video");
  if (player) player.play().catch(() => toast("请点击播放器中的播放按钮。"));
  if (fullscreen) await $("#mediaViewerBody").requestFullscreen();
}
async function toggleMediaFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await $("#mediaViewerBody").requestFullscreen();
}
async function closeMedia() {
  if (document.fullscreenElement) await document.exitFullscreen();
  $("#mediaViewer").close();
}
document.addEventListener("fullscreenchange", () => {
  const active = !!document.fullscreenElement;
  const button = $('#mediaViewer [data-action="mediaFullscreen"]');
  if (button) {
    button.setAttribute("aria-label", active ? "退出全屏" : "全屏播放");
    button.innerHTML =
      icon(active ? "minimize" : "maximize") +
      `<span>${active ? "退出全屏" : "全屏"}</span>`;
    window.lucide.createIcons();
  }
});
$("#mediaViewer").addEventListener("cancel", (ev) => {
  if (document.fullscreenElement) {
    ev.preventDefault();
    document.exitFullscreen().catch(() => {});
  }
});
$("#mediaViewer").addEventListener("close", async () => {
  if (document.fullscreenElement)
    await document.exitFullscreen().catch(() => {});
  const player = $("#mediaViewer").querySelector("video");
  if (player) {
    player.pause();
    player.removeAttribute("src");
    player.load();
  }
  $("#mediaViewerBody").innerHTML = "";
});

const historyEntry = () =>
  store.history.entries.find((h) => h.id === selectedHistory);
function historyDate(h) {
  if (!h.date)
    return h.year + (h.kind === "snapshot" ? " · 快照年份" : " · 日期待核实");
  const labels = {
    announcement: "公告 / UTC",
    patch: "补丁 / UTC",
    release: "主客户端更新",
    build: h.datePrecision === "month" ? "快照月份" : "构建快照",
  };
  return h.date + " · " + (labels[h.dateType] || "历史记录");
}
function renderHistoryRows(rows) {
  const parts = [];
  let updates = [];
  const flush = () => {
    if (!updates.length) return;
    const first = updates[0].date,
      last = updates.at(-1).date;
    parts.push(
      `<details class="client-updates" data-update-group="${esc(updates[0].id)}" ${query ? "open" : ""}><summary>${icon("layers")} ${updates.length} 次客户端更新 <small>${esc(first === last ? first : first + " — " + last)} / UTC</small></summary>${updates.map(historyRow).join("")}</details>`,
    );
    updates = [];
  };
  for (const row of rows) {
    if (row.kind === "client") updates.push(row);
    else {
      flush();
      parts.push(historyRow(row));
    }
  }
  flush();
  return parts.join("");
}
function clientDates(e) {
  return `<div><span>版本更新时间</span><b>${esc(historyDate({ date: e.updateDate, dateType: e.updateDateType, year: e.updateYear || e.year, datePrecision: e.updateDate?.length === 7 ? "month" : "day" }))}</b></div><div><span>本机构建快照</span><b title="${esc(e.snapshotDateSource || "仅保存包年份")}">${esc(e.snapshotDate || e.year)}</b></div>`;
}

const availabilityLabels = {
  local: "本机可用",
  available: "有可用版本",
  uncollected: "未收藏",
};
const availabilityLabel = (h) =>
  availabilityLabels[h?.availability] || "未收藏";
const clientHistory = (e) =>
  store.history.entries.find((h) => h.runtimeId === e.id);
function acquisitionInfo(h) {
  if (!h?.hasVersion && !h?.archive) return "";
  const a = h.archive;
  const location = a?.archivePresent
    ? a.usable
      ? "原包已归档"
      : "问题 / 不完整原包"
    : a?.collectionClaim
      ? "收藏中可下载"
      : h.source
        ? "已找到下载入口"
        : "原包尚未就绪";
  return `<section class="acquisition-info"><div class="section-label">版本资源 <small>${esc(location)}</small></div>${a?.note ? `<p class="hint">${esc(a.note)}</p>` : ""}${h.source ? `<p class="hint">${esc(h.source.label)} · 核对 ${esc(h.source.checkedOn)}<br>${esc(h.source.note)}</p>` : ""}<div class="acquisition-actions">${a && store.collection?.archiveRoot && !store.collection.error ? `<button class="button small ghost" data-archive-folder="${esc(a.historyId)}">${icon("folder-archive")}打开归档</button>` : ""}${h.source ? `<button class="button small ghost" data-download-source="${esc(h.id)}">${icon("copy")}复制下载入口</button>` : ""}</div></section>`;
}
function historyRow(h) {
  const e = h.owned ? store.entries.find((e) => e.id === h.runtimeId) : null;
  return `<button class="version-row history-row ${e ? "owned" : ""} ${selectedHistory === h.id ? "selected" : ""}" data-history="${esc(h.id)}" ${h.runtimeId ? `data-select="${esc(h.runtimeId)}"` : ""} data-testid="history-${esc(h.id)}" data-availability="${esc(h.availability)}" aria-pressed="${selectedHistory === h.id}">${e ? mediaCover(e.media, "row-cover", e.year) : ""}<div class="version-number ${!h.version || h.version.length > 8 ? "long" : ""}">${esc(h.version || "UPDATE")}</div><div><div class="row-title-line"><h3>${esc(h.title)}</h3><span class="row-status ${h.availability === "local" ? "installed" : h.availability === "available" ? "available" : "unavailable"}">${esc(availabilityLabel(h))}${e?.menuAvailable && !e.installed ? " · 仅主菜单" : ""}</span></div><div class="row-caption"><span>${esc(historyDate(h))}</span></div>${e ? `<div class="row-events">${esc(e.engine)}${e.events.length ? " · " + e.events.length + " 个 RPG" : ""}</div>` : ""}</div>${icon("chevron-right", "row-arrow")}</button>`;
}
function timeline() {
  const list = store.history.entries.filter(
    (h) =>
      (filter === "all" ||
        (filter === "patch" && h.kind !== "client") ||
        (filter === "owned" && h.localAvailable) ||
        (filter === "available" && h.hasVersion) ||
        (filter === "uncollected" && h.availability === "uncollected")) &&
      `${h.version} ${h.title} ${h.summary} ${h.year} ${h.date || ""} ${h.runtimeId || ""} ${
        h.runtimeId
          ? store.entries
              .find((e) => e.id === h.runtimeId)
              ?.events.map((e) => e.name)
              .join(" ") || ""
          : ""
      }`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const years = [...new Set(list.map((h) => h.year))];
  return `<section class="page-heading history-heading"><div><span class="eyebrow">DOTA 2 / 2010 — ${Math.max(...store.history.entries.map((h) => h.year))}</span><h1>历史时间线</h1><p>浏览版本更新，启动本机收藏。</p></div><div class="stats"><div class="stat"><b>${store.history.entries.length}</b><span>更新记录</span></div><div class="stat"><b>${store.history.entries.filter((h) => h.kind === "patch").length}</b><span>编号补丁</span></div><div class="stat"><b>${store.history.entries.filter((h) => h.localAvailable).length}</b><span>本机可用</span></div></div></section><div class="timeline-tools"><div class="filters"><span class="filter-label">${list.length} 条记录</span>${[
    ["all", "全部更新"],
    ["patch", "编号与收藏"],
    ["available", "有可用版本"],
    ["owned", "本机可用"],
    ["uncollected", "未收藏"],
  ]
    .map(
      ([f, label]) =>
        `<button class="chip ${filter === f ? "active" : ""}" data-filter="${f}" aria-pressed="${filter === f}">${label}</button>`,
    )
    .join(
      "",
    )}</div><nav class="year-jumps" aria-label="按年份跳转">${years.map((y) => `<button data-year="${y}">${y}</button>`).join("")}</nav></div><details class="coverage" data-disclosure-key="coverage"><summary>日期与收录说明</summary><p>${esc(store.history.coverage)}</p><p>主客户端更新与提前预告分别记录；公告时间采用 UTC。“有可用版本”表示已找到下载入口或已有收藏原包；“本机可用”需通过构建校验，2011 另标仅主菜单。原包归档与游戏试玩分别记录。本机快照表示保存包的构建日期。缺少日期的记录保留月份或年份精度，未核实节点列在当年末尾。</p></details>${
    list.length
      ? years
          .map((y) => {
            const rows = list.filter((h) => h.year === y);
            return `<section class="history-year" id="year-${y}"><div class="year-title"><b>${y}</b><span>${rows.length} 条记录</span></div><div class="timeline">${renderHistoryRows(rows)}</div></section>`;
          })
          .join("")
      : emptySearch("没有匹配的更新记录")
  }`;
}

function emptySearch(message) {
  return `<div class="empty">${icon("search")}<h3>${message}</h3><p>试试版本号、年份或地图名称。</p><button class="button ghost clear-search" data-action="clearSearch" data-reset-filter="true">清除搜索与筛选</button></div>`;
}

function historyInspector(h) {
  return `<div class="inspector-title">更新记录 ${icon("archive")}</div><span class="eyebrow">${h.year} / UPDATE INDEX</span><div class="display edition ${h.version.length > 8 ? "long" : ""}">${esc(h.version || "UPDATE")}</div><h2 class="inspect-heading">${esc(h.title)}</h2><p class="inspect-description">${esc(h.summary)}</p>${badge(availabilityLabel(h), h.availability === "available" ? "warm" : "dim")}${acquisitionInfo(h)}<div class="metadata"><div><span>更新时间</span><b>${esc(historyDate(h))}</b></div><div><span>运行目录</span><b>${h.runtimeId ? "尚未绑定" : "尚未准备"}</b></div></div><div class="callout">${h.runtimeId ? "需要使用时，解压到运行盘并绑定对应构建。" : h.hasVersion ? "资源入口已保存；下载后仍需核验构建和启动适配。" : "此更新已有历史资料，尚未取得对应客户端资源。"}</div>${h.runtimeId ? `<button class="button ghost wide" data-bind="${esc(h.runtimeId)}">${icon("folder-input")}绑定客户端</button>` : ""}<details class="detail-disclosure" data-disclosure-key="sources"><summary>日期依据与资料来源</summary><p class="hint">${esc(h.dateSourceLabel || h.sourceLabel)}</p>${h.dateNote ? `<p class="hint">${esc(h.dateNote)}</p>` : ""}${h.announcementDate ? `<p class="hint">提前预告：${esc(h.announcementDate)}</p>` : ""}${h.sourceTitle ? `<p class="hint">${esc(h.sourceTitle)}</p>` : ""}</details>${h.sourceUrl || h.dateSourceUrl ? `<button class="button ghost wide" data-history-source="${esc(h.id)}">${icon("copy")}复制来源地址</button>` : ""}<div id="sessionList" class="sessions">${sessionsPanel()}</div>`;
}

const rpgCategories = [
  {
    id: "official",
    title: "官方 RPG",
    subtitle: "VALVE / OFFICIAL EVENTS",
    description: "Valve 官方合作活动，按活动时期排列。",
    icon: "sparkles",
  },
  {
    id: "community",
    title: "游廊 RPG",
    subtitle: "COMMUNITY / DISCONTINUED",
    description: "社区作者制作、已经停更的游廊地图。",
    icon: "swords",
  },
];
function rpgCard(e) {
  const choices = e.runtimeChoices || [],
    available = choices.some((choice) => choice.event.available),
    versions = choices.length > 1 ? `${choices.length} 个客户端` : e.version;
  return `<button class="rpg ${selectedEvent === e.id ? "selected" : ""}" data-event="${e.id}" data-rpg-category="${e.category}" aria-pressed="${selectedEvent === e.id}">${mediaCover(e.media, "rpg-cover", e.period)}<div class="rpg-body"><div class="rpg-period">${esc(e.period)}${e.media?.videos?.length ? `<span class="rpg-video-badge">${icon("film")}影像</span>` : icon(e.category === "official" ? "sparkles" : "swords")}</div><h3>${esc(e.name)}</h3><div class="rpg-foot"><span>${esc(versions)}</span><span class="${available ? "installed" : "muted"}">${available ? (e.kind === "compat" ? "兼容入口就绪" : "本机就绪") : "待准备"}</span></div></div></button>`;
}

function rpg() {
  const events = allEvents().filter(
    (e) =>
      (filter === "all" || filter === e.category) &&
      `${e.name} ${e.version} ${e.period} ${e.runtimeChoices.map((choice) => choice.client.version).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return `<div class="page-heading"><div class="heading-copy"><span class="eyebrow">RPG ARCHIVE</span><h1>RPG 档案</h1><p>官方活动与游廊历史地图，按时期分区收藏。</p></div></div><div class="filters"><span class="filter-label">${events.length} 个地图入口</span>${[
    ["all", "全部分区"],
    ["official", "官方 RPG"],
    ["community", "游廊 RPG"],
  ]
    .map(
      ([f, label]) =>
        `<button class="chip ${filter === f ? "active" : ""}" data-filter="${f}" aria-pressed="${filter === f}">${label}</button>`,
    )
    .join("")}</div>${rpgCategories
    .map((category) => {
      const group = events
        .filter((e) => e.category === category.id)
        .sort((a, b) =>
          a.period.localeCompare(b.period, "zh-CN", { numeric: true }),
        );
      return group.length
        ? `<section class="rpg-section" data-rpg-group="${category.id}"><header class="rpg-section-head"><h2>${icon(category.icon)}${category.title}<small>${group.length}</small></h2></header><div class="rpg-grid">${group.map(rpgCard).join("")}</div></section>`
        : "";
    })
    .join("")}${events.length ? "" : emptySearch("没有匹配的 RPG 地图")}`;
}

function eventLinks(e) {
  return rpgCategories
    .map((category) => {
      const events = e.events.filter((v) => v.category === category.id);
      return events.length
        ? `<section data-event-group="${category.id}"><div class="section-label">此版本的${category.title} <small>${String(events.length).padStart(2, "0")}</small></div>${events.map((v) => `<button class="event-link" data-event="${v.id}">${icon(category.icon)}<span>${esc(v.name)}<small>${esc(v.period)} · ${v.kind === "compat" ? "兼容复原" : category.id === "community" ? (v.archiveType === "snapshot" ? "游廊历史快照" : "停更游廊") : "原生活动入口"}</small></span>${icon("chevron-right")}</button>`).join("")}</section>`
        : "";
    })
    .join("");
}
function roomEvents(e) {
  return rpgCategories
    .map((category) => {
      const events = e.events.filter((v) => v.category === category.id);
      return events.length
        ? `<optgroup label="${category.title}">${events.map((v) => `<option value="${v.id}" ${roomMode === v.id ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</optgroup>`
        : "";
    })
    .join("");
}

function room() {
  const versions = store.entries.filter((e) => e.playable && !e.prototype),
    e = versions.find((e) => e.id === roomVersion) || versions[0];
  const dedicated = e.id === "7.32" && roomMode === "bots";
  const event = roomEvent(e),
    mapStatus = event
      ? `<p class="hint" data-testid="room-map-status">${esc(event.name)} · ${esc(e.version)} · ${esc(event.launchDisabledReason ? "已发现不兼容" : event.verified || "待基础试玩")}</p>${event.validationNotes ? `<p class="hint" data-testid="room-map-validation">${esc(event.validationNotes)}</p>` : ""}${!event.available ? `<p class="hint unavailable" data-testid="room-map-unavailable">${esc(event.launchDisabledReason || event.note || "此地图入口尚未就绪。")}</p>` : ""}`
      : "";
  return `<div class="page-heading"><div class="heading-copy"><span class="eyebrow">LOCAL MULTIPLAYER</span><h1>本地房间</h1><p>同版本客户端，通过局域网或虚拟网络连接。</p></div><button class="button small ghost" data-room-jump="join">${icon("log-in")}加入已有房间</button></div><section class="form-block" id="room-host"><span class="room-step-label">01 / HOST</span><h2>创建房间</h2><div class="form-grid"><label class="field"><span>客户端版本</span><select id="roomVersion">${versions.map((v) => `<option value="${v.id}" ${v.id === e.id ? "selected" : ""}>${esc(v.version)} · ${v.installed ? "已绑定" : "未绑定"}</option>`).join("")}</select></label><label class="field"><span>比赛 / 活动</span><select id="roomMode"><option value="bots" ${roomMode === "bots" ? "selected" : ""}>普通比赛</option>${roomEvents(e)}</select></label><label class="field"><span>游戏 UDP 端口</span><input id="port" type="number" min="1024" max="65534" value="${draft.port}"></label><label class="field"><span>房间密码</span><input id="password" value="${esc(draft.password)}" autocomplete="off" maxlength="64"><small>字母、数字、下划线或连字符</small></label></div><details class="room-options" data-disclosure-key="room-options"><summary>语言与网络设置</summary><div class="form-grid">${languageSelector(e, "full")}<label class="field full"><span>监听网卡</span><select id="bind"><option value="">全部本机网卡</option>${store.networks.map((n) => `<option value="${n.address}" ${draft.bind === n.address ? "selected" : ""}>${esc(n.name)} · ${n.address}</option>`).join("")}</select></label></div><details class="network-options" data-disclosure-key="network-options" ${draft.internet ? "open" : ""}><summary>虚拟网络兼容设置</summary><label class="checkbox"><input id="internet" type="checkbox" ${draft.internet ? "checked" : ""}><span>虚拟网络兼容模式 <small>仅在旧引擎拒绝虚拟网段时启用（sv_lan 0）；不会创建公网 IP。</small></span></label></details></details><div class="room-route" data-testid="room-route"><strong>${dedicated ? "专服 · 7.32 / build 5397" : "房主客户端开服"}</strong><p>${dedicated ? "房主加入并入队后，再补充 Bot。" : e.listenHostBootstrap && roomMode === "bots" ? "房主自动加入天辉，其余真人席位保留。游戏须保持开启。" : "房间运行期间，房主客户端须保持开启。"}</p>${e.installed ? '<p class="hint" data-testid="room-console-shortcut">游戏控制台：F8（备用键）</p>' : ""}</div>${mapStatus}${!e.installed ? '<p class="hint unavailable">请先在版本库绑定对应客户端。</p>' : ""}<button class="button primary wide" data-action="host" ${!roomCanLaunch(e) ? "disabled" : ""}>${icon("network")}一键本地开服</button></section><section class="form-block join-block" id="room-join"><span class="room-step-label">02 / JOIN</span><h2>加入房间</h2><p class="hint">使用上方选定的版本、端口和密码。</p><div class="join-fields"><label class="field"><span>房主 IPv4 或主机名</span><input id="server" placeholder="例如：192.168.1.25" value="${esc(draft.server || "")}"></label><button class="button" data-action="join" ${!roomCanLaunch(e) ? "disabled" : ""}>${icon("log-in")}启动并连接</button></div></section>`;
}

function libraryView() {
  const entries = store.entries.filter((e) =>
    `${e.version} ${e.title} ${e.engine} ${e.root || ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return `<div class="page-heading"><div class="heading-copy"><span class="eyebrow">LOCAL COLLECTION</span><h1>我的版本库</h1><p>压缩包集中归档，运行目录按需准备。</p></div>${badge(store.history.entries.filter((h) => h.localAvailable).length + " 个本机可用", "dim")}</div><div class="library-toolbar"><button class="button" data-action="scan">${icon("folder-search")}扫描文件夹</button><button class="button ghost" data-action="dataFolder">${icon("folder-cog")}本机配置</button><button class="button ghost" data-action="bindArchives">${icon("folder-archive")}归档文件夹</button>${store.collection?.archiveRoot ? `<button class="button ghost" data-action="archiveFolder">${icon("folder-open")}打开归档库</button>` : ""}<span>${store.collection?.error ? esc(store.collection.error) : store.collection?.archiveRoot ? esc(store.collection.archiveRoot) : "归档目录尚未绑定"}</span></div><details class="detail-disclosure" data-config-status data-disclosure-key="config-state"><summary>配置位置与绑定状态</summary><p class="path">${esc(store.dataDirectory)}</p><p class="hint">${store.entries.filter((e) => e.root).length} 个已绑定目录 · ${store.entries.filter((e) => e.menuAvailable).length} 个本机入口</p><button class="button small ghost" data-action="refresh">${icon("refresh-cw")}重新读取绑定</button></details><div class="library-list">${entries.map((e) => `<div class="library-row ${selected === e.id ? "selected" : ""}"><button class="library-client" data-select="${e.id}" aria-pressed="${selected === e.id}" aria-label="查看 ${esc(e.version)}"><b>${esc(e.version)}</b><div><h3>${esc(e.title)} <span class="library-state ${e.installed ? "installed" : "unavailable"}">${esc(availabilityLabel(clientHistory(e)))}${e.menuAvailable && !e.installed ? " · 仅主菜单" : ""}</span></h3><p>${esc(e.root || e.reason)}</p></div></button><button class="button ghost" data-bind="${e.id}" ${!e.playable && !e.archiveExe ? "disabled" : ""}>${e.installed || e.archived ? "更换目录" : "绑定目录"}</button></div>`).join("")}${entries.length ? "" : emptySearch("没有匹配的客户端")}</div><div class="section-label">游廊地图包 <small>原始 VPK 校验</small></div>${allEvents()
    .filter((e) => e.category === "community")
    .map(
      (e) =>
        `<div class="library-row package-row"><div><h3>${esc(e.name)} ${badge(e.available ? "已绑定" : "待绑定", "dim")}</h3><p>Workshop ${e.workshopId}${e.available ? "" : " · " + esc(e.note)}</p></div><button class="button ghost" data-package="${e.id}">绑定 VPK</button></div>`,
    )
    .join(
      "",
    )}<p class="hint library-note">文件移动后请重新绑定。启动器不包含游戏本体或地图包。</p>`;
}

function sessionsPanel() {
  const list = store.sessions
    .filter((s) => activeStages.includes(s.stage))
    .concat(store.sessions.filter((s) => s.stage === "failed").slice(0, 1));
  if (!list.length)
    return `<div class="idle-status">${icon("circle-check")}当前没有运行会话</div>`;
  return `<div class="section-label">运行会话 <small>${list.length}</small></div>${list.map((s) => `<div class="session"><h4><span class="offline-dot"></span>${esc(s.version)} · ${s.type === "dedicated" ? "普通比赛专服" : s.mode === "aghanim1-skills" ? "迷宫 · 技能编辑器" : s.mode === "skills" ? "技能编辑器" : s.mode === "menu" ? "主菜单" : s.mode === "bots" ? "普通比赛" : esc(allEvents().find((e) => e.id === s.mode)?.name || s.mode)}</h4><span class="hint">${stageText[s.stage] || esc(s.stage)}</span>${["skills", "aghanim1-skills"].includes(s.mode) && s.skillEditorPhase ? `<p class="hint" data-testid="skill-editor-phase">${skillEditorPhaseText[s.skillEditorPhase] || "正在准备技能编辑器"}</p>` : ""}${s.skillEditorError ? `<p class="session-error" data-testid="skill-editor-error">${esc(s.skillEditorError)}</p>` : ""}${s.error ? `<p class="session-error">${esc(s.error)}</p>` : ""}<div class="session-actions">${["starting", "loading", "running"].includes(s.stage) ? `<button class="button small ghost" data-stop="${s.id}">${icon("square")}结束</button>` : ""}<button class="button small ghost" data-log="${s.id}">${icon("file-text")}日志</button>${s.type === "dedicated" && s.stage === "running" ? `<button class="button small" data-join-own="${s.id}">房主加入</button><button class="button small ghost" data-fill="${s.id}">补充 Bot</button>` : ""}</div></div>`).join("")}`;
}

function connectionCode() {
  const ip = draft.bind || store.networks[0]?.address || "房主IP";
  return `password "${draft.password}"\nconnect ${ip}:${draft.port}`;
}
function roomTeamHelp() {
  if (roomMode !== "bots") return "";
  if (roomVersion === "7.32")
    return '<div class="callout" data-testid="dedicated-team-help"><strong>7.32 普通比赛入队</strong><br><code>jointeam 2</code> 天辉 / <code>jointeam 3</code> 夜魇。真人入队后再补 Bot。</div>';
  const e = store.entries.find((item) => item.id === roomVersion);
  return e?.listenHostBootstrap
    ? '<div class="callout" data-testid="listen-host-team-help"><strong>来客入队</strong><br>等待地图加载后，再输入 <code>jointeam good</code> 天辉 / <code>jointeam bad</code> 夜魇。</div>'
    : "";
}
function roomInspector() {
  return `<div class="inspector-title">多人连接 ${icon("network")}</div><h2 class="inspect-heading">连接到房主</h2><p class="hint">同局域网使用房主 IPv4；异地使用 UU 等工具提供的可互访地址。</p><div class="connection-card"><span class="section-label">游戏控制台</span><pre class="code-block">${esc(connectionCode())}</pre><button class="button wide ghost" data-action="copy">${icon("copy")}复制连接命令</button></div><div class="steps"><div class="step"><div><strong>核对客户端与地图</strong><br>真实构建须一致，双方使用各自 Steam 账户。</div></div><div class="step"><div><strong>开服并允许 UDP 入站</strong><br>房主防火墙规则须匹配当前网络类型。</div></div><div class="step"><div><strong>在游戏控制台输入命令</strong><br>也可在左侧填写房主地址，启动并连接。</div></div></div>${roomTeamHelp()}<details class="detail-disclosure" data-disclosure-key="connection-notes"><summary>公网与联机注意事项</summary><p class="hint">127.0.0.1 仅连接本机。公网直连需要可入站的公网 IP 与游戏 UDP 转发；兼容模式不会打通网络。程序不会修改防火墙。</p><p class="hint">仅分享游戏连接地址与房间密码，不分享 RCON、日志或 private 文件。跨机连接、活动人数和中途加入仍待验证。</p></details><div id="sessionList" class="sessions">${sessionsPanel()}</div>`;
}

function inspector() {
  if (view === "room") return roomInspector();
  const h = view === "timeline" ? historyEntry() : null;
  if (h && !h.owned) return historyInspector(h);
  const e = entry(),
    event = e.events.find((v) => v.id === selectedEvent);
  const skillsAction =
    !event && hasSkillEditor(e)
      ? `<button class="button wide ghost" data-launch="skills" ${!canSkills(e) ? "disabled" : ""}>${icon("wand-sparkles")}技能编辑器</button><p class="hint" data-testid="skill-editor-guidance">先进入主菜单，再打开任意英雄的原生试玩，技能面板会自动载入。只编辑工具新增的技能。</p>`
      : hasLabyrinthSkills(e, event)
        ? `<button class="button wide ghost" data-launch="aghanim1-skills" ${!canLabyrinthSkills(e, event) ? "disabled" : ""}>${icon("wand-sparkles")}启动迷宫 · 技能编辑器</button><p class="hint" data-testid="labyrinth-skill-editor-guidance">单人作弊模式。锁定英雄后打开游戏内面板；原有技能与碎片保留，只编辑工具新增技能。</p>`
        : "";
  const status = !event
    ? availabilityLabel(h || clientHistory(e)) +
      (e.menuAvailable && !e.installed ? " · 仅主菜单" : "")
    : e.installed
      ? event.launchDisabledReason
        ? "已发现不兼容"
        : (event.kind === "compat" ? "兼容复原 · " : "") +
          (event.verified || "待基础试玩")
      : "请先绑定客户端";
  const actions = e.installed
    ? event
      ? `<button class="button primary wide" data-launch="${event.id}" ${!canPlay(e) || !event.available ? "disabled" : ""}>${icon("play")}启动 ${esc(event.name)}</button>${!event.available ? `<p class="hint unavailable" data-testid="map-runtime-reason">${esc(event.launchDisabledReason || event.note)}</p>` : ""}<button class="button wide ghost" data-room-event="${event.id}">${icon("network")}配置本地房间</button>`
      : `<button class="button primary wide" data-launch="bots" ${!canPlay(e) ? "disabled" : ""}>${icon("play")}进入普通比赛${e.prototype ? " · 莉娜 / 9 Bot" : ""}</button><div class="action-pair"><button class="button ghost" data-launch="menu" ${!canPlay(e) ? "disabled" : ""}>${icon("layout-dashboard")}主菜单</button><button class="button ghost" data-action="room" ${e.prototype ? "disabled" : ""}>${icon("network")}本地开服</button></div>`
    : e.menuAvailable
      ? `<button class="button primary wide" data-launch="menu" ${!canMenu(e) ? "disabled" : ""}>${icon("layout-dashboard")}进入主菜单</button><p class="hint">比赛组件缺失，仅提供菜单浏览。</p>`
      : `<div class="callout">${e.playable ? "绑定对应客户端后，即可查看影像并启动。" : e.menuOnly ? "绑定此历史包后可进入主菜单；比赛组件缺失。" : "此包缺少比赛组件，仅可浏览档案影像。"}</div>${e.playable ? `<button class="button wide ghost" data-bind="${e.id}">${icon("folder-input")}绑定客户端</button>` : ""}`;
  return `<div class="inspector-title">${event ? "地图档案" : "版本档案"}<button class="icon-button" data-action="clientFolder" title="打开客户端文件夹" aria-label="打开客户端文件夹" ${!e.root ? "disabled" : ""}>${icon("folder-open")}</button></div>${event?.media || e.installed || e.archived ? inspectorCover(event?.media || e.media, e.year) : ""}<div class="detail-header"><span class="eyebrow">${event ? esc(event.period) + " / " + (event.category === "official" ? "VALVE EVENT" : "COMMUNITY RPG") : (e.updateYear || e.year) + " / " + (e.source2 ? "SOURCE TWO" : "SOURCE ONE")}</span><div class="detail-heading"><span class="detail-version display">${esc(e.version)}</span><h2 class="inspect-heading ${event ? "event-heading" : ""}">${esc(event?.name || e.title)}</h2></div>${event ? `<p class="detail-subline">${esc(e.engine)} · ${event.kind === "compat" ? "兼容复原" : event.category === "official" ? "原生活动" : event.archiveType === "snapshot" ? "游廊历史快照" : "停更游廊"}</p>` : ""}${badge(status, e.installed ? "" : "warm")}</div><div class="launch-actions detail-launch">${event ? eventClientSelector(event) : ""}${event?.validationNotes ? `<p class="hint" data-testid="map-runtime-validation">${esc(event.validationNotes)}</p>` : ""}${languageSelector(e, "language-inline")}${actions}${skillsAction}${e.installed || e.menuAvailable ? '<p class="hint" data-testid="console-shortcut">游戏控制台：F8（备用键）</p>' : ""}</div>${event?.media?.videos?.length ? `<button class="button wide ghost rpg-play-media" data-media-fullscreen="${esc(event.media.videos[0].id)}">${icon("film")}全屏播放影像${event.media.videos.length > 1 ? " · " + event.media.videos.length + " 段" : ""}</button>` : ""}<details class="detail-disclosure detail-copy" data-disclosure-key="description"><summary>${event ? "地图介绍" : "版本说明"}</summary><p class="inspect-description">${esc(event?.description || e.description)}</p></details><div class="metadata date-metadata">${clientDates(e)}</div>${mediaGallery(event || e)}<details class="detail-disclosure" data-disclosure-key="build"><summary>构建与验证</summary><div class="metadata"><div><span>运行引擎</span><b>${esc(e.engine)}</b></div><div><span>真实构建</span><b>${esc(e.build || "缺少组件")}</b></div><div><span>活动入口</span><b>${e.events.length} 个</b></div><div><span>多人连接</span><b>跨机待验证</b></div></div>${event ? `<p class="hint">${esc(event.note)}</p>` : ""}<p class="hint">${esc(e.snapshotDateSource || "仅保存包年份")}</p><p class="hint">活动保留原始难度；基础试玩不代表完整通关。</p>${e.root ? `<p class="path">${esc(e.root)}</p>` : ""}</details>${event ? "" : acquisitionInfo(h || clientHistory(e))}${event ? "" : eventLinks(e)}<div id="sessionList" class="sessions">${sessionsPanel()}</div>`;
}

let renderedSignature = null,
  renderedSelection = null,
  renderedView = null;
function captureFocus() {
  const node = document.activeElement;
  if (!node || !$("#app").contains(node)) return null;
  const scope = node.closest(".inspector")
    ? ".inspector"
    : node.closest("#content")
      ? "#content"
      : ".topbar,.sidebar";
  if (node.tagName === "SUMMARY" && node.parentElement.dataset.disclosureKey)
    return {
      attr: "data-disclosure-key",
      value: node.parentElement.dataset.disclosureKey,
      summary: true,
      scope,
    };
  const attr = node.id
    ? "id"
    : [...node.attributes].find((a) =>
        [
          "data-history",
          "data-event",
          "data-select",
          "data-filter",
          "data-action",
          "data-year",
          "data-launch-language",
          "data-event-client",
          "data-view",
          "data-bind",
          "data-media",
          "data-import-media",
          "data-room-event",
          "data-launch",
        ].includes(a.name),
      )?.name;
  if (!attr) return null;
  return {
    attr,
    value: node.getAttribute(attr),
    start: node.selectionStart,
    end: node.selectionEnd,
    direction: node.selectionDirection,
    scope,
  };
}
function restoreFocus(focus) {
  if (!focus) return;
  let node = [...$("#app").querySelectorAll(`[${focus.attr}]`)].find(
    (el) =>
      el.getAttribute(focus.attr) === focus.value && el.closest(focus.scope),
  );
  if (focus.summary) node = node?.querySelector("summary");
  if (!node || node.disabled) return;
  node.focus({ preventScroll: true });
  if (typeof focus.start === "number" && node.setSelectionRange)
    node.setSelectionRange(focus.start, focus.end, focus.direction || "none");
}
function updateYearPosition() {
  const content = $("#content");
  if (view !== "timeline" || !content) return;
  const years = [...content.querySelectorAll(".history-year")];
  if (!years.length) return;
  const threshold =
    content.getBoundingClientRect().top +
    ($(".timeline-tools")?.offsetHeight || 0) +
    32;
  const current =
    years
      .filter((year) => year.getBoundingClientRect().top <= threshold + 1)
      .at(-1) || years[0];
  for (const button of content.querySelectorAll("[data-year]")) {
    const active = current.id === "year-" + button.dataset.year;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "date");
    else button.removeAttribute("aria-current");
  }
}
function render() {
  if (searchComposing) return;
  const signature = JSON.stringify([view, filter, query]);
  const selection = JSON.stringify([
    view,
    selectedHistory,
    selected,
    selectedEvent,
    roomVersion,
    roomMode,
  ]);
  const keepPosition = signature === renderedSignature;
  const sameSelection = selection === renderedSelection;
  const focus = renderedView === view ? captureFocus() : null;
  const contentTop = keepPosition ? $("#content")?.scrollTop || 0 : 0;
  const inspectorTop = sameSelection ? $(".inspector")?.scrollTop || 0 : 0;
  const openDetails = [
    ...document.querySelectorAll("[data-disclosure-key][open]"),
  ]
    .filter((d) => (d.closest(".inspector") ? sameSelection : keepPosition))
    .map((d) => d.dataset.disclosureKey);
  const openUpdates = keepPosition
    ? [...document.querySelectorAll("[data-update-group][open]")].map(
        (d) => d.dataset.updateGroup,
      )
    : [];
  const labels = {
    timeline: "历史时间线",
    rpg: "RPG 档案",
    room: "本地房间",
    library: "我的版本库",
  };
  $("#app").innerHTML =
    `<div class="shell" data-view="${view}">${sidebar()}<main class="main"><header class="topbar"><div class="breadcrumb"><span>档案馆</span>${icon("chevron-right")}<strong>${labels[view]}</strong></div>${view === "room" ? '<span class="topbar-context">同版本联机 · 本地配置</span>' : `<div class="search">${icon("search")}<input id="search" data-testid="search" value="${esc(query)}" placeholder="搜索版本、年份或地图" aria-label="搜索版本、年份或地图" autocomplete="off" spellcheck="false">${query ? `<button class="icon-button search-clear" data-action="clearSearch" aria-label="清除搜索">${icon("x")}</button>` : '<kbd class="search-shortcut">Ctrl F</kbd>'}</div>`}<button class="icon-button" data-action="refresh" title="刷新本地档案" aria-label="刷新本地档案">${icon("refresh-cw")}</button></header><div class="workspace"><div id="content" class="content ${renderedView !== view ? "page-enter" : ""}">${view === "timeline" ? timeline() : view === "rpg" ? rpg() : view === "room" ? room() : libraryView()}</div><aside class="inspector" aria-label="${view === "room" ? "多人连接说明" : "当前选项详情"}">${inspector()}</aside></div></main><footer class="statusbar"><span>${icon("hard-drive")}${store.entries.filter((e) => e.installed).length} 个比赛客户端<span class="status-separator">·</span>${store.entries.filter((e) => e.menuAvailable && !e.installed).length} 个主菜单档案</span><span id="footerSessions">${activeCount()} 个会话 · 档案核验 ${store.reviewDate}</span></footer></div>`;
  window.lucide.createIcons();
  $("#content").scrollTop = contentTop;
  for (const id of openUpdates) {
    const d = [...document.querySelectorAll("[data-update-group]")].find(
      (d) => d.dataset.updateGroup === id,
    );
    if (d) d.open = true;
  }
  for (const key of openDetails) {
    for (const d of document.querySelectorAll("[data-disclosure-key]"))
      if (d.dataset.disclosureKey === key) d.open = true;
  }
  $(".inspector").scrollTop = inspectorTop;
  restoreFocus(focus);
  let scrollFrame;
  $("#content").addEventListener(
    "scroll",
    () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(updateYearPosition);
    },
    { passive: true },
  );
  updateYearPosition();
  renderedSignature = signature;
  renderedSelection = selection;
  renderedView = view;
}
const activeCount = () =>
  store.sessions.filter((s) => activeStages.includes(s.stage)).length;
async function refresh() {
  store = await api.snapshot();
  if (!draft) draft = { ...store.room, server: "" };
  render();
}
function nav(target) {
  view = target;
  selectedEvent = null;
  if (target === "rpg") {
    const first = entry().events[0] || allEvents()[0];
    if (first) {
      selectedEvent = first.id;
      selected = eventClientId(first);
    }
  }
  selectedHistory =
    target === "timeline"
      ? store.history.entries.find((h) => h.runtimeId === selected)?.id || null
      : null;
  filter = "all";
  query = "";
  render();
}
function selectEvent(id) {
  const v = allEvents().find((e) => e.id === id);
  if (!v) return;
  selected = eventClientId(v, view === "timeline" ? selected : null);
  eventClientSelections.set(id, selected);
  selectedEvent = id;
  if (view !== "rpg") {
    view = "rpg";
    filter = v.category;
    query = "";
  }
  render();
}
function gatherRoom() {
  if (view === "room") {
    draft = {
      ...draft,
      port: Number($("#port").value),
      password: $("#password").value,
      bind: $("#bind").value,
      internet: $("#internet").checked,
      server: $("#server").value,
    };
  }
  return { ...draft };
}
document.addEventListener("input", (ev) => {
  if (ev.target.id === "search") {
    if (searchComposing || ev.isComposing) return;
    query = ev.target.value;
    render();
  } else if (["port", "password", "server"].includes(ev.target.id)) {
    gatherRoom();
    if ($(".code-block")) $(".code-block").textContent = connectionCode();
  }
});
document.addEventListener("compositionstart", (ev) => {
  if (ev.target.id === "search") searchComposing = true;
});
document.addEventListener("compositionend", (ev) => {
  if (ev.target.id !== "search") return;
  searchComposing = false;
  query = ev.target.value;
  render();
});
function clearSearch(resetFilter = false) {
  query = "";
  if (resetFilter) filter = "all";
  render();
  $("#search")?.focus({ preventScroll: true });
}
document.addEventListener("keydown", (ev) => {
  if (
    ev.isComposing ||
    searchComposing ||
    document.querySelector("dialog[open]")
  )
    return;
  if (
    (ev.ctrlKey || ev.metaKey) &&
    ["f", "k"].includes(ev.key.toLowerCase()) &&
    $("#search")
  ) {
    ev.preventDefault();
    $("#search").focus({ preventScroll: true });
    $("#search").select();
  } else if (ev.key === "Escape" && query && ev.target.id === "search") {
    ev.preventDefault();
    clearSearch();
  }
});
document.addEventListener("change", async (ev) => {
  if (ev.target.dataset.eventClient) {
    const id = ev.target.dataset.eventClient,
      choice = eventRuntimeChoices(id).find(
        (item) => item.client.id === ev.target.value,
      );
    if (!choice || id !== selectedEvent || launchSettingsBusy) return;
    selected = choice.client.id;
    eventClientSelections.set(id, selected);
    render();
    return;
  }
  if (ev.target.dataset.launchLanguage) {
    const input = {
      id: ev.target.dataset.launchLanguage,
      language: ev.target.value,
    };
    launchSettingsBusy = true;
    render();
    try {
      await api.saveLaunchOptions(input);
      await refresh();
      toast("语言已保存，将用于此版本的下次启动。");
    } catch (error) {
      toast(error.message);
    } finally {
      launchSettingsBusy = false;
      render();
      if (entry().id === input.id)
        document
          .querySelector(`[data-launch-language="${CSS.escape(input.id)}"]`)
          ?.focus({ preventScroll: true });
    }
    return;
  }
  if (ev.target.id === "roomVersion") {
    gatherRoom();
    roomVersion = ev.target.value;
    const next = store.entries.find((item) => item.id === roomVersion),
      resetMode =
        roomMode !== "bots" &&
        !next?.events.some((event) => event.id === roomMode);
    if (resetMode) roomMode = "bots";
    else if (roomMode !== "bots")
      eventClientSelections.set(roomMode, roomVersion);
    selected = roomVersion;
    selectedEvent = null;
    render();
    if (resetMode) toast("该客户端没有此地图入口，已切换为普通比赛。");
  } else if (ev.target.id === "roomMode") {
    gatherRoom();
    roomMode = ev.target.value;
    if (roomMode !== "bots") eventClientSelections.set(roomMode, roomVersion);
    render();
  } else if (["bind", "internet"].includes(ev.target.id)) {
    gatherRoom();
    render();
  }
});
document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("button");
  if (!b || b.disabled) return;
  try {
    if (b.dataset.history) {
      selectedHistory = b.dataset.history;
      const h = historyEntry();
      if (h.runtimeId) selected = h.runtimeId;
      selectedEvent = null;
      render();
      return;
    }
    if (b.dataset.year) {
      const year = document.getElementById("year-" + b.dataset.year),
        content = $("#content");
      if (year)
        content.scrollTo({
          top:
            content.scrollTop +
            year.getBoundingClientRect().top -
            content.getBoundingClientRect().top -
            ($(".timeline-tools")?.offsetHeight || 0) -
            18,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
        });
      return;
    }
    if (b.dataset.roomJump) {
      const section = document.getElementById("room-" + b.dataset.roomJump),
        content = $("#content");
      if (section)
        content.scrollTo({
          top:
            content.scrollTop +
            section.getBoundingClientRect().top -
            content.getBoundingClientRect().top -
            18,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
        });
      if (b.dataset.roomJump === "join")
        $("#server")?.focus({ preventScroll: true });
      return;
    }
    if (b.dataset.archiveFolder) {
      await api.openFolder({ kind: "archive", id: b.dataset.archiveFolder });
      return;
    }
    if (b.dataset.downloadSource) {
      const h = store.history.entries.find(
        (h) => h.id === b.dataset.downloadSource,
      );
      if (h?.source?.sourceUrl) {
        await api.copy(h.source.sourceUrl);
        toast("下载入口已复制；请下载至归档盘。");
      }
      return;
    }
    if (b.dataset.historySource) {
      const h = store.history.entries.find(
        (h) => h.id === b.dataset.historySource,
      );
      if (h?.dateSourceUrl || h?.sourceUrl) {
        await api.copy(h.dateSourceUrl || h.sourceUrl);
        toast("来源地址已复制。");
      }
      return;
    }
    if (b.dataset.mediaFullscreen) {
      await showMedia(b.dataset.mediaFullscreen, true);
      return;
    }
    if (b.dataset.media) {
      await showMedia(b.dataset.media);
      return;
    }
    if (b.dataset.importMedia) {
      if (
        await api.importMedia({
          id: b.dataset.mediaOwner,
          kind: b.dataset.importMedia,
        })
      ) {
        await refresh();
        toast("素材已保存到本机媒体库。");
      }
      return;
    }
    if (b.dataset.action === "closeMedia") {
      await closeMedia();
      return;
    }
    if (b.dataset.action === "mediaFullscreen") {
      await toggleMediaFullscreen();
      return;
    }
    if (b.dataset.view) {
      nav(b.dataset.view);
      return;
    }
    if (b.dataset.filter) {
      filter = b.dataset.filter;
      if (view === "rpg" && filter !== "all") {
        const current = allEvents().find((event) => event.id === selectedEvent);
        if (current?.category !== filter) {
          const first = allEvents().find((event) => event.category === filter);
          if (first) {
            selectedEvent = first.id;
            selected = eventClientId(first);
          }
        }
      }
      render();
      return;
    }
    if (b.dataset.select) {
      selected = b.dataset.select;
      selectedEvent = null;
      render();
      return;
    }
    if (b.dataset.event) {
      selectEvent(b.dataset.event);
      return;
    }
    if (b.dataset.bind) {
      const result = await api.bind({ id: b.dataset.bind });
      if (result) {
        await refresh();
        toast("客户端目录已绑定，构建指纹通过。");
      }
      return;
    }
    if (b.dataset.package) {
      if (await api.package({ id: b.dataset.package })) {
        await refresh();
        toast("原始游廊包指纹通过。");
      }
      return;
    }
    if (b.dataset.prepare) {
      await api.prepare({ id: selected, mode: b.dataset.prepare });
      await refresh();
      toast("兼容入口已准备，原文件备份在本机配置目录。");
      return;
    }
    if (b.dataset.launch) {
      await api.launch({ id: selected, mode: b.dataset.launch });
      await refresh();
      toast("启动任务已提交，运行状态将显示在右侧。");
      return;
    }
    if (b.dataset.roomEvent) {
      roomVersion = selected;
      roomMode = b.dataset.roomEvent;
      nav("room");
      return;
    }
    if (b.dataset.log) {
      await api.openFolder({ kind: "session", id: b.dataset.log });
      return;
    }
    if (b.dataset.fill) {
      await api.fillBots({ id: b.dataset.fill });
      toast("已请求补 Bot；仅在真人席位建立后的选人阶段允许。");
      return;
    }
    if (b.dataset.joinOwn) {
      const s = store.sessions.find((s) => s.id === b.dataset.joinOwn);
      await api.join({
        id: s.version,
        joinMode: s.mode,
        server: s.room.bind || "127.0.0.1",
        room: s.room,
      });
      await refresh();
      toast("房主客户端正在连接，入场后请 jointeam 2 或 jointeam 3。");
      return;
    }
    if (b.dataset.stop) {
      const d = $("#confirm");
      d.showModal();
      const choice = await new Promise((r) =>
        d.addEventListener("close", () => r(d.returnValue), { once: true }),
      );
      if (choice === "stop") {
        await api.stop({ id: b.dataset.stop });
        toast("已请求结束本次运行，等待恢复临时设置。");
      }
      return;
    }
    switch (b.dataset.action) {
      case "clearSearch":
        clearSearch(b.dataset.resetFilter === "true");
        break;
      case "bindArchives":
        if (await api.bindArchives()) {
          await refresh();
          toast("归档目录已绑定。");
        }
        break;
      case "archiveFolder":
        await api.openFolder({ kind: "archive" });
        break;
      case "refresh":
        await refresh();
        toast("已重新核对客户端与地图入口。");
        break;
      case "room":
        roomVersion = selected;
        roomMode = "bots";
        nav("room");
        break;
      case "scan": {
        const found = await api.scan();
        await refresh();
        toast(`已识别并绑定 ${found.length} 个客户端。`);
        break;
      }
      case "dataFolder":
        await api.openFolder({ kind: "data" });
        break;
      case "clientFolder":
        await api.openFolder({ kind: "client", id: selected });
        break;
      case "copy":
        gatherRoom();
        await api.copy(connectionCode());
        b.classList.add("copy-success");
        b.innerHTML = icon("check") + "连接命令已复制";
        window.lucide.createIcons();
        setTimeout(() => {
          if (!b.isConnected) return;
          b.classList.remove("copy-success");
          b.innerHTML = icon("copy") + "复制连接命令";
          window.lucide.createIcons();
        }, 2500);
        toast("已复制控制台连接命令。");
        break;
      case "host": {
        if (!roomCanLaunch(store.entries.find((e) => e.id === roomVersion)))
          return;
        const r = gatherRoom();
        await api.host({ id: roomVersion, mode: roomMode, room: r });
        await refresh();
        toast("开服任务已提交，等待右侧状态变为正在运行。");
        break;
      }
      case "join": {
        if (!roomCanLaunch(store.entries.find((e) => e.id === roomVersion)))
          return;
        const r = gatherRoom();
        await api.join({
          id: roomVersion,
          joinMode: roomMode,
          server: r.server,
          room: r,
        });
        await refresh();
        toast("同版本客户端正在连接房主。");
        break;
      }
    }
  } catch (err) {
    toast(err.message);
  }
});
async function poll() {
  try {
    const data = await api.status();
    if (data.configRevision !== store.configRevision) await refresh();
    const previousSessions = JSON.stringify(store.sessions);
    store.sessions = data.sessions;
    for (const s of store.sessions) {
      const previous = lastStages.get(s.id);
      if (previous !== s.stage && s.stage === "failed")
        toast(s.error || "启动失败，请打开本次会话日志。");
      lastStages.set(s.id, s.stage);
    }
    if (
      $("#sessionList") &&
      previousSessions !== JSON.stringify(store.sessions)
    ) {
      $("#sessionList").innerHTML = sessionsPanel();
      window.lucide.createIcons();
    }
    const e = entry();
    for (const button of document.querySelectorAll("[data-launch]")) {
      const mode = button.dataset.launch;
      const event = e.events.find((item) => item.id === mode);
      button.disabled =
        mode === "menu"
          ? !canMenu(e)
          : mode === "skills"
            ? !canSkills(e)
            : mode === "aghanim1-skills"
              ? !canLabyrinthSkills(
                  e,
                  e.events.find((item) => item.id === "aghanim1"),
                )
              : !canPlay(e) || (mode !== "bots" && !event?.available);
    }
    if ($("#footerSessions"))
      $("#footerSessions").textContent =
        `${activeCount()} 个运行会话 · 档案核验 ${store.reviewDate}`;
  } catch (error) {
    toast(error.message || "无法重新读取绑定，请检查本机配置。");
  }
}
function showCompatAction() {
  const e = entry(),
    event = e.events.find((v) => v.id === selectedEvent);
  if (
    !e.installed ||
    !event ||
    event.kind !== "compat" ||
    event.available ||
    document.querySelector("[data-prepare]")
  )
    return;
  const launch = document.querySelector(`[data-launch="${event.id}"]`);
  if (!launch) return;
  const button = document.createElement("button");
  button.className = "button wide mt-3";
  button.dataset.prepare = event.id;
  button.innerHTML = icon("wrench") + "准备兼容入口（备份原文件）";
  launch.insertAdjacentElement("afterend", button);
  const note = document.createElement("p");
  note.className = "hint mt-3";
  note.textContent =
    event.id === "wraith-night"
      ? "为旧活动补充实体创建接口适配；保留原始地图、波次与数值。"
      : "仅为已退役的在线活动积分接口增加存在检查，保留原版战斗与结算。";
  button.insertAdjacentElement("afterend", note);
  window.lucide.createIcons();
}
new MutationObserver(() => {
  if (store) showCompatAction();
}).observe($("#app"), { childList: true, subtree: true });
refresh()
  .then(() => {
    for (const s of store.sessions) lastStages.set(s.id, s.stage);
    setInterval(poll, 3000);
  })
  .catch((err) => {
    $("#app").innerHTML =
      `<div class="boot">ARCHIVE UNAVAILABLE<span>${esc(err.message)}</span></div>`;
  });
