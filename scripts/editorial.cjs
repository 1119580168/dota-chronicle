// Maintainer-only historical copy. These overlays cannot grant runtime capability.
const clients = require("../resources/editorial/clients.json");
const patches = [
  ...require("../resources/editorial/patches-early.json"),
  ...require("../resources/editorial/patches-middle.json"),
  ...require("../resources/editorial/patches-late.json"),
];
function applyClientEditorial(catalog) {
  const byId = new Map(clients.map((copy) => [copy.id, copy]));
  for (const entry of catalog.entries) {
    const copy = byId.get(entry.id);
    if (copy)
      Object.assign(entry, {
        title: copy.title,
        kicker: copy.kicker,
        description: copy.description,
        contentSources: copy.contentSources,
        ...(copy.contentNote ? { contentNote: copy.contentNote } : {}),
      });
  }
  return catalog;
}
function applyHistoryEditorial(rows) {
  const byVersion = new Map(patches.map((copy) => [copy.version, copy]));
  for (const row of rows) {
    const copy = row.kind === "patch" && byVersion.get(row.version);
    if (copy)
      Object.assign(row, {
        title: copy.title,
        summary: copy.summary,
        contentSources: copy.contentSources,
        ...(copy.contentNote ? { contentNote: copy.contentNote } : {}),
      });
  }
  return rows;
}
module.exports = { applyClientEditorial, applyHistoryEditorial };
