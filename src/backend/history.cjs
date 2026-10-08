// Historical records never grant launch capability. Only an exact catalog ID can be linked.
const { compareHistory } = require("./chronology.cjs");
function orderClients(history, entries) {
  const records = new Map(
    history.entries.filter((h) => h.runtimeId).map((h) => [h.runtimeId, h]),
  );
  return entries
    .map((e) => {
      const h = records.get(e.id);
      return {
        ...e,
        updateDate: h?.date || null,
        updateDateType: h?.dateType || null,
        updateYear: h?.year || e.year,
      };
    })
    .sort((a, b) =>
      compareHistory(records.get(a.id) || a, records.get(b.id) || b),
    );
}
function hydrateHistory(
  history,
  entries,
  collection = { sources: [], records: [] },
) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const sources = new Map(
    (collection.sources || []).map((s) => [s.historyId, s]),
  );
  const archives = new Map(
    (collection.records || []).map((r) => [r.historyId, r]),
  );
  return {
    ...history,
    entries: [...history.entries].sort(compareHistory).map((row) => {
      const e = byId.get(row.runtimeId);
      const source = sources.get(row.id) || null;
      const archive = archives.get(row.id) || null;
      const localAvailable = !!(e?.installed || e?.menuAvailable);
      const available =
        !!source ||
        !!(
          archive?.usable &&
          (archive.archivePresent || archive.collectionClaim)
        );
      return {
        ...row,
        runtimeId: e?.id || null,
        owned: !!(e?.installed || e?.archived),
        playable: !!e?.installed,
        localAvailable,
        hasVersion: localAvailable || available,
        availability: localAvailable
          ? "local"
          : available
            ? "available"
            : "uncollected",
        source,
        archive,
        snapshotYear: e?.year || null,
        snapshotDate: e?.snapshotDate || null,
      };
    }),
  };
}
module.exports = { hydrateHistory, orderClients };
