// Build-time importer for the owner's reviewed manifests. Never executed by the app.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const lab = process.argv[2];
if (!lab)
  throw Error(
    "Usage: node scripts/import-research.cjs <validation folder> <prototype root>",
  );
const read = (f) =>
  JSON.parse(fs.readFileSync(path.join(lab, f), "utf8").replace(/^\uFEFF/, ""));
const hints = {
  "6.77c": [
    2013,
    "初代竞技场",
    "早期 Source 1",
    "成熟的 Source 1 界面、旧地图与选人流程。与原型版对照，观察从概念验证走向正式比赛的变化。",
  ],
  "6.78b": [
    2013,
    "TI3 时代",
    "Source 1 基线",
    "以 TI3 前后的英雄、地图和旧卡牌选人界面，记录第一代 Dota 2 的竞技面貌。",
  ],
  "6.80c": [
    2014,
    "节庆的实验",
    "早期官方合作活动",
    "收录冥魂之夜和 2014 年兽。本包是 2014 年快照，活动入口经过兼容复原，不作为活动首发当天的精确构建。",
  ],
  6.81: [
    2014,
    "TI4 时代",
    "Source 1 的演进",
    "延续第一代引擎与 HUD，适合对照英雄、商店和地图细节。",
  ],
  6.83: [
    2014,
    "最后的旧界面年代",
    "Source 1 后期",
    "记录 Reborn 之前的选人、装备与战场。普通比赛已完成真人基础试玩。",
  ],
  "6.85b": [
    2015,
    "RE BORN",
    "Source 2 与游廊",
    "Reborn 时代的客户端快照。引擎、主界面和自定义游戏生态进入新的阶段。",
  ],
  "6.88c": [
    2016,
    "6.xx 的尾声",
    "7.00 前的对照组",
    "保留大版本跃迁前的战场与界面，是观察后续天赋、背包变化的对照基线。",
  ],
  "build2311-20170716": [
    2017,
    "新纪元之后",
    "天赋 · 背包 · 齐天大圣",
    "2017-07-16 / build 2311 的实际快照，已有齐天大圣和背包。收藏文件名曾写作 7.00，但它不是 7.00 首发构建。",
  ],
  7.19: [
    2018,
    "合作冒险的黄金期",
    "4 个官方入口 · 2 张游廊",
    "集中保存暗月、破泞之战两章、冥晶之窟，以及两张已经停更的著名游廊地图。",
  ],
  7.22: [
    2019,
    "神杖的扩展",
    "迎霜节保存点",
    "以所有英雄神杖升级时代的客户端作为竞技节点，同时保存迎霜节的原生活动入口。",
  ],
  "7.23e": [
    2019,
    "世外之争",
    "中立物品 · 前哨",
    "记录中立物品、前哨与信使等系统变化后的客户端，构成规则演进的重要节点。",
  ],
  "7.27c": [
    2020,
    "迷宫开启",
    "阿哈利姆的试炼",
    "保存阿哈利姆迷宫一期：传奇碎片、分支房间和合作挑战。",
  ],
  "7.30e": [
    2022,
    "再入天地迷宫",
    "阿哈利姆迷宫二期",
    "2022-02-21 保存包，为天地迷宫的展示候选。原 steam.inf 的构建字段不是数字，使用文件指纹识别。",
  ],
  7.32: [
    2022,
    "本地房间基线",
    "同版本专服 · 普通比赛",
    "build 5397 已验证同版本专服与本机真人直连。跨电脑与公网联机留待后续条件具备时验收。",
  ],
  "7.37e": [
    2025,
    "现代 Dota 的轮廓",
    "先天技能与命石之后",
    "build 6310 / 2025-02-06 保存点，用于展示进入先天技能与命石时代后的客户端。",
  ],
};
const profiles = read("launchers/native-client-profile-manifest.json").profiles;
const local = {
  schema: 1,
  roots: {},
  packages: {},
  room: { port: 30323, password: "chronicle-room", bind: "", internet: false },
};
const entries = profiles.map((p) => {
  const [year, title, kicker, description] = hints[p.version];
  local.roots[p.version] = p.root;
  return {
    id: p.version,
    version: p.version.startsWith("build") ? "Build 2311" : p.version,
    year,
    title,
    kicker,
    description,
    engine: p.source2 ? "Source 2" : "Source 1",
    source2: p.source2,
    exe: p.exeRelative,
    steamInf: p.steamInfRelative,
    sha: p.steamInfSha256,
    build: p.actualBuildKnown ? p.ClientVersion : "指纹识别",
    clientVersion: p.ClientVersion,
    serverVersion: p.ServerVersion,
    playable: true,
    verified: "基础试玩通过",
    events: [],
  };
});
const community = read(
  "reports/community-package-acquisition-and-integrity.json",
);
const events = [
  [
    "6.80c",
    "wraith-night",
    "冥魂之夜",
    "2013",
    "frostivus",
    "frostivus",
    "五人合作抵御怪物，守卫冥魂王。已通过刷怪、技能与战斗基础试玩；完整 13 波未验收。",
    "compat",
  ],
  [
    "6.80c",
    "nian2014",
    "2014 年兽",
    "2014",
    "nian",
    "nian3",
    "原生 nian3 地图：购买装备、离开出生点与攻击年兽已通过手动测试。",
    "native",
  ],
  [
    "7.19",
    "darkmoon",
    "暗月",
    "2017",
    "new_bloom_2017",
    "siege02",
    "守护神殿、抵御 15 波敌人。首波战斗与失败返回菜单已验证；完整通关未验收。",
    "compat",
  ],
  [
    "7.19",
    "siltbreaker1",
    "破泞之战 · 第一章",
    "2017",
    "dungeon",
    "ep_1",
    "开场任务、移动与技能已通过手动测试。单人难度较高；未完成整章。",
    "native",
  ],
  [
    "7.19",
    "siltbreaker2",
    "破泞之战 · 第二章",
    "2017",
    "dungeon",
    "ep_2",
    "开场战斗、死亡与复活、失败返回菜单已验证；未完成整章。",
    "native",
  ],
  [
    "7.19",
    "underhollow",
    "冥晶之窟",
    "2018",
    "cavern",
    "cavern",
    "房间探索与战斗入口已通过手动测试，没有缺模型。单人未清完首个战斗房间。",
    "native",
  ],
  [
    "7.22",
    "frosthaven",
    "迎霜节",
    "2018",
    "winter_2018",
    "winter",
    "首波敌人、施法、失败返回菜单与下一局已验证；未完成全部 15 波。",
    "native",
  ],
  [
    "7.27c",
    "aghanim1",
    "阿哈利姆迷宫",
    "2020",
    "aghanim",
    "main",
    "传奇碎片与房间战斗已验证；原生失败与下一局正常，未完成整场迷宫。",
    "native",
  ],
  [
    "7.30e",
    "aghanim2",
    "阿哈利姆天地迷宫",
    "2021–2022",
    "aghanim",
    "hub",
    "开场对话、碎片、选路与战斗已验证；失败返回和下一局正常。",
    "native",
  ],
].map(([version, id, name, period, addon, map, description, kind]) => ({
  version,
  id,
  name,
  period,
  addon,
  map,
  description,
  kind,
  category: "official",
  verified: "基础试玩通过",
  multiplayer: "待跨机验证",
}));
for (const [id, name, map, wid, period, description] of [
  [
    "epic-boss-fight",
    "Epic Boss Fight",
    "epic_boss_fight_normal",
    "305278898",
    "2018 停更",
    "经典合作 Boss 挑战。原包完整性与真人战斗已验证，未完成全流程。",
  ],
  [
    "wtfplus-old",
    "WTF+ (OLD)",
    "dota",
    "476601122",
    "2018 停更",
    "旧版 WTF+，作者已迁移到新项目。本包原始文件已校验；跨机 PvP 尚未验证。",
  ],
]) {
  const p = community.find((x) => x.workshopId === wid);
  local.packages[id] = p.package;
  events.push({
    version: "7.19",
    id,
    name,
    map,
    workshopId: wid,
    packageSha: p.sha256,
    period,
    description,
    kind: "native",
    category: "community",
    verified: "基础试玩通过",
    multiplayer: "待跨机验证",
  });
}
for (const e of events) entries.find((x) => x.id === e.version).events.push(e);
// Known installed bootstrap fingerprints. Neither game scripts nor client binaries are shipped.
entries.find((x) => x.id === "6.80c").events[0].requirements = [
  {
    path: "dota/addons/frostivus/scripts/vscripts/addon_init.lua",
    sha: "d013d554913ebc2634ec5786de5153bd244d9ee3aee74cf051332dae6787e093",
  },
  {
    path: "dota/addons/frostivus/scripts/vscripts/history_legacy_spawn_compat.lua",
    sha: "fc21fbe87dbe8aaece85f5d562fdbd162a960f7484c169294e11c6ed9655e482",
  },
];
entries
  .find((x) => x.id === "7.19")
  .events.find((x) => x.id === "darkmoon").requirements = [
  {
    path: "game/dota_addons/new_bloom_2017/scripts/vscripts/holdout_game_ui.lua",
    sha: "4adcd96e27d817e0a9883b2fa239d479c820edec9691f0d6d60972e5884cfe50",
  },
];
const proto = process.argv[3];
if (proto) {
  local.roots["2010"] = proto;
  const sha = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(proto, "dota/steam.inf")))
    .digest("hex");
  entries.unshift({
    id: "2010",
    version: "2010 Prototype",
    year: 2010,
    title: "一切尚在原型之中",
    kicker: "档案起点 · 原型引擎",
    description:
      "depot 883 v0 原型。已验证进入原始地图、操控英雄与 9 个机器人。普通入口使用莉娜，保留原版倒计时。",
    engine: "Source 1",
    source2: false,
    exe: "hl2.exe",
    steamInf: "dota/steam.inf",
    sha,
    build: "Prototype 37",
    prototype: true,
    playable: true,
    verified: "基础试玩通过",
    events: [],
  });
}
entries.push({
  id: "2011",
  version: "2011 Beta",
  year: 2011,
  title: "TI1 的历史切片",
  kicker: "历史记录 · 比赛组件缺失",
  description:
    "现有 2011 年 7 月包能进入主界面，但缺少同构建 server.dll。保留为编年节点，不提供不可用的比赛入口。",
  engine: "Source 1",
  playable: false,
  verified: "不完整档案",
  events: [],
});
entries.sort(
  (a, b) =>
    a.year - b.year ||
    Object.keys(hints).indexOf(a.id) - Object.keys(hints).indexOf(b.id),
);
const root = path.resolve(__dirname, "..");
require("./editorial.cjs").applyClientEditorial({ entries });
require("./community-catalog.cjs").applyCommunityCatalog({ entries });
fs.mkdirSync(path.join(root, "resources"), { recursive: true });
fs.mkdirSync(path.join(root, "local"), { recursive: true });
fs.writeFileSync(
  path.join(root, "resources/catalog.json"),
  JSON.stringify({ schema: 1, reviewDate: "2026-10-04", entries }, null, 2),
);
fs.writeFileSync(
  path.join(root, "local/library.json"),
  JSON.stringify(local, null, 2),
);
console.log(
  `${entries.length} historical entries, ${events.length} RPG entries. Local paths remain ignored.`,
);
