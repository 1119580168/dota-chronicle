const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { MediaLibrary, rangeFor } = require("../src/backend/media.cjs");
const files = require("../src/backend/files.cjs");
async function mediaFixture(t) {
  const data = await fs.mkdtemp(
    path.join(os.tmpdir(), "chronicle-media-errors-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(data)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(data).startsWith("chronicle-media-errors-"));
    await fs.rm(data, { recursive: true, force: true });
  });
  const media = await new MediaLibrary(data, {
    entries: [{ id: "version", events: [{ id: "event" }] }],
  }).load();
  const source = path.join(data, "source.png");
  await fs.writeFile(source, Buffer.from("89504e470d0a1a0a0102", "hex"));
  await media.importFile("version", "cover", source);
  return {
    data,
    media,
    source,
    indexFile: path.join(data, "media/index.json"),
  };
}
test("video seek handles bounded and suffix ranges and rejects invalid requests", () => {
  assert.deepEqual(rangeFor("bytes=3-6", 10), {
    start: 3,
    end: 6,
    partial: true,
  });
  assert.deepEqual(rangeFor("bytes=-4", 10), {
    start: 6,
    end: 9,
    partial: true,
  });
  for (const h of [
    "bytes=10-",
    "bytes=7-3",
    "bytes=-0",
    "bytes=0-2,4-8",
    "bytes=9007199254740992-",
  ])
    assert.throws(() => rangeFor(h, 10));
});
test("a damaged media index preserves existing bindings, disables importing and does not block snapshots", async (t) => {
  const { media, source, indexFile } = await mediaFixture(t);
  const oldIndex = structuredClone(media.index),
    damaged = "{broken original index";
  await fs.writeFile(indexFile, damaged);
  await media.load();
  assert.equal(media.status.available, false);
  assert.equal(media.status.canImport, false);
  assert.equal(media.status.file, indexFile);
  assert.match(media.status.error, /媒体索引不可用/);
  assert.deepEqual(media.index, oldIndex);
  const snapshot = await media.hydrate({
    entries: [{ id: "version", installed: true, events: [{ id: "event" }] }],
  });
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.mediaStatus.canImport, false);
  assert.equal(snapshot.entries[0].media.status.canImport, false);
  assert.equal(snapshot.entries[0].events[0].media.status.canImport, false);
  await assert.rejects(
    media.importFile("version", "menu", source),
    /媒体索引不可用/,
  );
  assert.equal(await fs.readFile(indexFile, "utf8"), damaged);
  await fs.writeFile(indexFile, JSON.stringify(oldIndex));
  await media.load();
  assert.equal(media.status.canImport, true);
  assert.ok((await media.forTarget("version")).cover);
});
test("only ENOENT creates a new media library; malformed schemas never overwrite the original", async (t) => {
  const { media, source, indexFile } = await mediaFixture(t);
  for (const invalid of [
    null,
    { schema: 2, assets: {}, targets: {} },
    { schema: 1, assets: [], targets: {} },
    { schema: 1, assets: {}, targets: [] },
    { schema: 1, assets: {}, targets: { version: { videos: "not-an-array" } } },
    { schema: 1, assets: {}, targets: { version: { menu: 3 } } },
    {
      schema: 1,
      assets: { ["a".repeat(64)]: { file: "../source.png", kind: "cover" } },
      targets: {},
    },
  ]) {
    const original = JSON.stringify(invalid);
    await fs.writeFile(indexFile, original);
    await media.load();
    assert.equal(media.status.canImport, false);
    await assert.rejects(
      media.importFile("version", "menu", source),
      /媒体索引不可用/,
    );
    assert.equal(await fs.readFile(indexFile, "utf8"), original);
  }
});
test("media index access errors are visible and do not rewrite previously readable data", async (t) => {
  const { media, source, indexFile } = await mediaFixture(t);
  const original = await fs.readFile(indexFile, "utf8"),
    readJson = files.readJson;
  t.mock.method(files, "readJson", async (file) => {
    if (file === indexFile)
      throw Object.assign(Error("fixture access denied"), { code: "EACCES" });
    return readJson(file);
  });
  await media.load();
  assert.match(media.status.error, /fixture access denied/);
  await assert.rejects(
    media.importFile("version", "menu", source),
    /fixture access denied/,
  );
  assert.equal(await fs.readFile(indexFile, "utf8"), original);
});
test("damaged media configuration cannot silently redirect imports to the default library", async (t) => {
  const { data, media, source, indexFile } = await mediaFixture(t);
  const original = await fs.readFile(indexFile, "utf8"),
    configFile = path.join(data, "media.json");
  for (const config of [
    "{broken configuration",
    "null",
    "{}",
    JSON.stringify({ root: "relative-library" }),
  ]) {
    await fs.writeFile(configFile, config);
    await media.load();
    assert.equal(media.status.canImport, false);
    assert.equal(media.status.file, configFile);
    await assert.rejects(
      media.importFile("version", "menu", source),
      /媒体配置不可用/,
    );
    assert.equal(await fs.readFile(configFile, "utf8"), config);
    assert.equal(await fs.readFile(indexFile, "utf8"), original);
  }
});
test("import rechecks the index changed after the last successful snapshot", async (t) => {
  const { media, source, indexFile } = await mediaFixture(t);
  assert.equal(media.status.canImport, true);
  const damaged = "index damaged after refresh";
  await fs.writeFile(indexFile, damaged);
  await assert.rejects(
    media.importFile("version", "menu", source),
    /媒体索引不可用/,
  );
  assert.equal(await fs.readFile(indexFile, "utf8"), damaged);
});
test("a newly selected library with no index does not retain bindings from the previous root", async (t) => {
  const { data, media, source } = await mediaFixture(t);
  const root = path.join(data, "new-library");
  await fs.writeFile(path.join(data, "media.json"), JSON.stringify({ root }));
  await media.load();
  assert.equal(media.status.canImport, true);
  assert.deepEqual(media.index, { schema: 1, assets: {}, targets: {} });
  await media.importFile("event", "menu", source);
  assert.deepEqual(Object.keys(media.index.targets), ["event"]);
});
test("media protocol streams selected local assets, rejects unknown IDs and escaped paths", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-media-"));
  try {
    const m = await new MediaLibrary(data, {
      entries: [{ id: "version", events: [] }],
    }).load();
    const source = path.join(data, "test.webm");
    await fs.writeFile(source, Buffer.from("1a45dfa3010203040506", "hex"));
    await m.importFile("version", "video", source);
    const v = (await m.forTarget("version")).videos[0];
    const response = await m.response(
      new Request(v.url, { headers: { range: "bytes=4-7" } }),
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), "bytes 4-7/10");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from([1, 2, 3, 4]),
    );
    assert.equal(
      (
        await m.response(
          new Request(v.url, { headers: { range: "bytes=15-" } }),
        )
      ).status,
      416,
    );
    assert.equal(
      (await m.response(new Request(v.url.replace(v.id, "f".repeat(64)))))
        .status,
      404,
    );
    m.index.assets[v.id].file = "../test.webm";
    assert.equal((await m.response(new Request(v.url))).status, 404);
    await assert.rejects(m.importFile("unknown", "video", source));
  } finally {
    await fs.rm(data, { recursive: true, force: true });
  }
});
