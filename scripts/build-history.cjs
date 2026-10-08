// Maintainer-only importer. The desktop application reads the resulting JSON offline.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { compareHistory } = require("../src/backend/chronology.cjs");
const { applyHistoryEditorial } = require("./editorial.cjs");
const ROOT = path.resolve(__dirname, "..");
const clean = (text) =>
  String(text || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\r/g, "");
function extractPatch(n) {
  const body = clean(n.contents),
    heading = n.title.match(/\b([67]\.\d{2}[a-z]?)\b/);
  // Only explicit patch headings/parity changes; incidental old-version comparisons do not qualify.
  return (
    heading?.[1] ||
    body.match(
      /(?:^|\n)\s*[-*]?\s*([67]\.\d{2}[a-z]?)\s*(?::|\n\s*[=\-]{2,}|Gameplay|Patch Notes|Full details|gameplay parity)/i,
    )?.[1] ||
    body.match(
      /(?:Updated Dota 2 to|Implemented|Made all)\s+([67]\.\d{2}[a-z]?)\s+(?:parity|gameplay)/i,
    )?.[1]
  );
}
function classify(body) {
  const t = clean(body),
    tags = [];
  if (/gameplay|hero|ability|damage|cooldown/i.test(t)) tags.push("英雄与玩法");
  if (/interface|UI\b|dashboard|panorama|tooltip/i.test(t)) tags.push("界面");
  if (/crash|performance|render|memory/i.test(t)) tags.push("稳定性");
  if (/workshop|custom game/i.test(t)) tags.push("游廊");
  if (
    /dark moon|siltbreaker|frostivus|new bloom|year beast|diretide|wraith/i.test(
      t,
    )
  )
    tags.push("活动");
  return tags.length
    ? tags.slice(0, 3).join(" / ") + "调整"
    : "客户端功能与问题修复";
}
function buildHistory(
  patches,
  news,
  announcements,
  catalog,
  overrides,
  milestones = [],
  dates = [],
) {
  const rows = [],
    patchMap = new Map(),
    seen = new Set();
  const modern = new Set(patches.map((p) => p.patch_number));
  for (const n of [...news].sort((a, b) => a.date - b.date)) {
    if (n.feedname !== "steam_updates") continue;
    const text = clean(n.contents).replace(/\s+/g, " ").trim();
    const date = new Date(n.date * 1000).toISOString().slice(0, 10);
    const signature = date + " " + text;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const version = extractPatch(n);
    const numbered = version && !modern.has(version) && !patchMap.has(version);
    const id = numbered
      ? "patch-" + version
      : "update-" +
        crypto
          .createHash("sha256")
          .update(signature)
          .digest("hex")
          .slice(0, 16);
    const row = {
      id,
      version: numbered ? version : "",
      year: Number(date.slice(0, 4)),
      date,
      dateType: "announcement",
      kind: numbered ? "patch" : "client",
      title: numbered ? "玩法更新" : "客户端更新",
      summary: classify(n.contents),
      sourceTitle: n.title,
      sourceUrl: String(n.url).replace(/^http:/, "https:"),
      sourceLabel: "Valve · Steam 更新公告",
    };
    rows.push(row);
    if (numbered) patchMap.set(version, row);
  }
  for (const p of patches) {
    const version = p.patch_number,
      date = new Date(p.patch_timestamp * 1000).toISOString().slice(0, 10);
    const row = {
      id: "patch-" + version,
      version,
      year: Number(date.slice(0, 4)),
      date,
      dateType: "patch",
      kind: "patch",
      title: /[a-z]$/.test(version) ? "平衡修订" : "玩法更新",
      summary: /[a-z]$/.test(version)
        ? "编号补丁的后续平衡修订。"
        : "新的编号玩法补丁。",
      sourceUrl: "https://www.dota2.com/patches/" + version,
      sourceLabel: "Valve · 官方补丁索引",
    };
    rows.push(row);
    patchMap.set(version, row);
  }
  for (const o of overrides) {
    let row = patchMap.get(o.version);
    const official = announcements.find(
      (n) => o.announcementTitle && n.title === o.announcementTitle,
    );
    if (!row) {
      row = {
        id: "patch-" + o.version,
        version: o.version,
        kind: "patch",
        year: o.year,
        date: null,
        dateType: "unverified",
        title: "玩法更新",
        summary: "早期规则版本；Dota 2 落地日期待核实。",
        sourceLabel: "Valve · 历史补丁页面",
        sourceUrl: o.sourceUrl,
      };
      rows.push(row);
      patchMap.set(o.version, row);
    }
    if (official) {
      row.date = new Date(official.date * 1000).toISOString().slice(0, 10);
      row.year = Number(row.date.slice(0, 4));
      row.dateType = "announcement";
      row.sourceUrl = official.url;
      row.sourceTitle = official.title;
      row.sourceLabel = "Valve · 官方公告";
    }
    if (o.sourceLabel) row.sourceLabel = o.sourceLabel;
    if (o.title) row.title = o.title;
    if (o.summary) row.summary = o.summary;
  }
  for (const m of milestones) {
    const announcement = announcements.find(
      (n) => n.title === m.announcementTitle,
    );
    if (!announcement)
      throw Error("Missing official milestone: " + m.announcementTitle);
    const date = new Date(announcement.date * 1000).toISOString().slice(0, 10);
    rows.push({
      id: "milestone-" + m.id,
      version: m.version,
      kind: "milestone",
      year: Number(date.slice(0, 4)),
      date,
      dateType: "announcement",
      title: m.title,
      summary: m.summary,
      sourceTitle: announcement.title,
      sourceUrl: announcement.url,
      sourceLabel: "Valve · 官方公告",
    });
  }
  for (const d of dates) {
    let row = patchMap.get(d.version);
    if (!row) {
      row = {
        id: "patch-" + d.version,
        version: d.version,
        kind: "patch",
        title: "玩法更新",
        summary: "Dota 2 主客户端的玩法平衡更新。",
        sourceUrl: d.dateSourceUrl,
        sourceLabel: d.dateSourceLabel,
      };
      rows.push(row);
      patchMap.set(d.version, row);
    }
    if (row.date && row.dateType === "announcement")
      row.announcementDate = row.date;
    Object.assign(row, d, {
      year: Number(d.date.slice(0, 4)),
      dateType: "release",
    });
  }
  for (const e of catalog.entries) {
    const numbered = patchMap.get(e.id);
    if (numbered) {
      numbered.runtimeId = e.id;
      continue;
    }
    rows.push({
      id: "snapshot-" + e.id,
      version: e.version,
      year: e.year,
      date: e.snapshotDate || null,
      dateType: e.snapshotDate ? "build" : "snapshot",
      kind: "snapshot",
      runtimeId: e.id,
      title: e.title,
      summary: e.description,
      contentSources: e.contentSources || [],
      ...(e.contentNote ? { contentNote: e.contentNote } : {}),
      sourceLabel: "本机客户端档案",
      sourceUrl: "",
      sourceTitle: "构建 " + (e.build || "组件不完整"),
      dateNote: e.snapshotDateSource || "",
      datePrecision: e.snapshotDate?.length === 7 ? "month" : "day",
    });
  }
  applyHistoryEditorial(rows);
  rows.sort(compareHistory);
  return {
    schema: 1,
    reviewDate: "2026-10-05",
    coverage:
      "2010 年原型与收藏快照；Valve Steam 客户端更新公告（2011–2021）；官方编号玩法补丁及字母修订（2018–2026）。历史日期按来源区分，未核实日期不补写。尚不保证所有 Steam 构建、无公告热修或早期字母版本完整。",
    sources: [
      "https://www.dota2.com/datafeed/patchnoteslist?language=english",
      "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=570&count=1000&maxlength=0&feeds=steam_updates",
      "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=570&count=1000&enddate=1517471999&maxlength=0&feeds=steam_community_announcements",
      "https://github.com/odota/dotaconstants/blob/master/build/patch.json",
      "https://liquipedia.net/dota2/Client_Patches",
    ],
    entries: rows,
  };
}
if (require.main === module) {
  const input = process.argv[2];
  if (!input)
    throw Error(
      "Usage: node scripts/build-history.cjs <directory of official API snapshots>",
    );
  const read = (name) =>
    JSON.parse(
      fs.readFileSync(path.join(input, name), "utf8").replace(/^\uFEFF/, ""),
    );
  const result = buildHistory(
    read("valve-patches.json").patches,
    [
      ...read("valve-news-pre2018.json").appnews.newsitems,
      ...read("valve-news-recent.json").appnews.newsitems,
    ],
    read("valve-announcements-pre2018.json").appnews.newsitems,
    require("../resources/catalog.json"),
    require("../resources/history-overrides.json"),
    require("../resources/history-milestones.json"),
    require("../resources/history-dates.json"),
  );
  fs.writeFileSync(
    path.join(ROOT, "resources/history.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    result.entries.length +
      " records, " +
      result.entries.filter((r) => r.kind === "patch").length +
      " numbered patches",
  );
}
module.exports = { buildHistory, extractPatch };
