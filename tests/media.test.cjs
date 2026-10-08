const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { MediaLibrary, rangeFor } = require("../src/backend/media.cjs");
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
