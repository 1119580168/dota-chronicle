const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  readArchiveIndex,
  archiveSnapshot,
  archiveFolder,
} = require("../src/backend/archives.cjs");
const { hydrateHistory } = require("../src/backend/history.cjs");
const { Library } = require("../src/backend/library.cjs");
const { writeJson } = require("../src/backend/files.cjs");
const history = require("../resources/history.json");
const sources = require("../resources/client-sources.json");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-archives-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "client"));
  for (const name of ["one.zip", "two.z01"])
    await fs.writeFile(path.join(root, "client", name), "fixture");
  const index = {
    schema: 1,
    entries: [
      {
        historyId: "patch-7.22",
        version: "7.22",
        folder: "client",
        usable: true,
        files: ["one.zip", "two.z01"].map((name) => ({
          path: "client/" + name,
          bytes: 7,
        })),
      },
    ],
  };
  await writeJson(path.join(root, "archive-index.json"), index);
  return { root, index };
}

test("archive presence requires every split file and never substitutes for a runtime", async (t) => {
  const { root } = await fixture(t);
  let collection = await archiveSnapshot(root);
  assert.equal(collection.records[0].archivePresent, true);
  assert.equal(collection.records[0].archiveBytes, 14);
  let row = hydrateHistory(history, [], collection).entries.find(
    (r) => r.id === "patch-7.22",
  );
  assert.equal(row.availability, "available");
  assert.equal(row.runtimeId, null);
  assert.equal(row.playable, false);
  assert.equal(row.owned, false);
  await fs.writeFile(path.join(root, "client/two.z01"), "wrong length");
  collection = await archiveSnapshot(root);
  assert.equal(collection.records[0].archivePresent, false);
  row = hydrateHistory(history, [], collection).entries.find(
    (r) => r.id === "patch-7.22",
  );
  assert.equal(row.availability, "uncollected");
  await fs.unlink(path.join(root, "client/two.z01"));
  assert.equal((await archiveSnapshot(root)).records[0].archivePresent, false);
});

test("archive index rejects path escapes, duplicate records and linked folders", async (t) => {
  const { root, index } = await fixture(t);
  const file = path.join(root, "archive-index.json");
  for (const invalid of [
    { ...index, entries: [...index.entries, index.entries[0]] },
    { ...index, entries: [{ ...index.entries[0], folder: "../outside" }] },
    {
      ...index,
      entries: [
        { ...index.entries[0], files: [{ path: "../outside.zip", bytes: 7 }] },
      ],
    },
    {
      ...index,
      entries: [
        { ...index.entries[0], files: [{ path: "client/one.zip", bytes: -1 }] },
      ],
    },
  ]) {
    await writeJson(file, invalid);
    await assert.rejects(readArchiveIndex(root));
    assert.equal((await archiveSnapshot(root)).records.length, 0);
  }
  await fs.symlink(
    path.join(root, "client"),
    path.join(root, "linked"),
    "junction",
  );
  await writeJson(file, {
    ...index,
    entries: [{ ...index.entries[0], folder: "linked" }],
  });
  await assert.rejects(readArchiveIndex(root), /链接|联接/);
  await writeJson(file, index);
  assert.equal(
    await archiveFolder(root, "patch-7.22"),
    path.join(root, "client"),
  );
  await assert.rejects(archiveFolder(root, "patch-7.23"), /未知/);
});

test("public sources and collection claims preserve exact letter patches and the 2017 build alias", async () => {
  assert.equal(sources.entries.length, 32);
  assert.equal(new Set(sources.entries.map((s) => s.historyId)).size, 32);
  assert.ok(
    sources.entries.every((s) =>
      history.entries.some((h) => h.id === s.historyId),
    ),
  );
  const collection = await archiveSnapshot(null, sources);
  collection.records = [
    {
      historyId: "patch-6.86e",
      usable: true,
      collectionClaim: true,
      archivePresent: false,
    },
    { historyId: "patch-7.00", usable: false, archivePresent: true },
    {
      historyId: "snapshot-build2311-20170716",
      usable: true,
      archivePresent: true,
    },
    { historyId: "snapshot-2011", usable: false, archivePresent: true },
  ];
  const hydrated = hydrateHistory(
    history,
    [{ id: "2011", installed: false, archived: true, menuAvailable: true }],
    collection,
  );
  const byId = (id) => hydrated.entries.find((r) => r.id === id);
  assert.equal(byId("patch-6.86e").availability, "available");
  assert.equal(byId("patch-6.86").availability, "uncollected");
  assert.equal(byId("patch-7.03").availability, "uncollected");
  assert.equal(byId("snapshot-build2311-20170716").availability, "available");
  assert.equal(byId("patch-7.00").availability, "available"); // Separate publisher source, despite bad local package.
  assert.equal(
    hydrated.entries.find((r) => r.runtimeId === "2011").availability,
    "local",
  );
  assert.equal(
    hydrated.entries.find((r) => r.runtimeId === "2011").playable,
    false,
  );
  assert.ok(hydrated.entries.every((r) => !r.playable));
  const badOnly = hydrateHistory(history, [], {
    records: [collection.records[1]],
    sources: [],
  });
  assert.equal(
    badOnly.entries.find((r) => r.id === "patch-7.00").availability,
    "uncollected",
  );
});

test("archive binding persists without changing runtime roots or map bindings", async (t) => {
  const { root } = await fixture(t);
  const data = path.join(root, "config");
  const existing = {
    schema: 1,
    roots: { existing: "unmodified" },
    packages: { existing: "unmodified" },
  };
  await writeJson(path.join(data, "library.json"), existing);
  const lib = await new Library({ entries: [] }, data, sources).load();
  await lib.bindArchives(root);
  const reloaded = await new Library({ entries: [] }, data, sources).load();
  assert.deepEqual(reloaded.config.roots, existing.roots);
  assert.deepEqual(reloaded.config.packages, existing.packages);
  const snapshot = await reloaded.snapshot();
  assert.equal(snapshot.collection.archiveRoot, root);
  assert.equal(snapshot.collection.records[0].archivePresent, true);
  assert.equal(snapshot.entries.length, 0);
  assert.equal(snapshot.collection.sources.length, 32);
});
