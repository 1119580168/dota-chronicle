const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { exportBindings } = require("../src/backend/storage.cjs");
const { MediaLibrary } = require("../src/backend/media.cjs");
const files = require("../src/backend/files.cjs");
const asset = "a".repeat(64);
const index = {
  schema: 1,
  assets: {
    [asset]: {
      file: "assets/cover.png",
      kind: "cover",
      title: "isolated cover",
    },
  },
  targets: { 7.19: { cover: asset } },
};

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), "chronicle-export-");
  const root = await fs.mkdtemp(prefix);
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));
    return fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "data");
  const config = {
    schema: 1,
    roots: { 7.19: path.join(root, "unlaunchable-client") },
  };
  await files.writeJson(path.join(source, "library.json"), config);
  await files.writeJson(
    path.join(source, "sessions", "evidence", "state.json"),
    { preserve: true },
  );
  await fs.mkdir(path.join(source, "client.lock"));
  return { root, source, config };
}

async function media(root) {
  await files.writeJson(path.join(root, "index.json"), index);
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(
    path.join(root, "assets", "cover.png"),
    "unrenderable isolated image bytes",
  );
}

for (const configured of [undefined, "media", "custom-media/nested"]) {
  test(`exported ${configured || "default"} media remains available after old data is renamed`, async (t) => {
    const { root, source, config } = await fixture(t);
    const mediaRoot = path.join(source, configured || "media");
    await media(mediaRoot);
    if (configured)
      await files.writeJson(path.join(source, "media.json"), {
        root: mediaRoot,
      });
    const originalIndex = await fs.readFile(path.join(mediaRoot, "index.json"));
    const target = await exportBindings(source, root, config);
    await assert.rejects(fs.stat(path.join(target, "media.json")), {
      code: "ENOENT",
    });
    assert.deepEqual(
      await fs.readFile(path.join(target, "media", "index.json")),
      originalIndex,
    );
    await assert.rejects(fs.stat(path.join(target, "sessions")), {
      code: "ENOENT",
    });
    const backup = path.join(root, "old-data-preserved");
    assert.equal(path.dirname(path.resolve(source)), path.resolve(root));
    assert.equal(path.dirname(path.resolve(backup)), path.resolve(root));
    await fs.rename(source, backup);
    await fs.rename(target, source);
    const library = await new MediaLibrary(source, {
      entries: [{ id: "7.19", events: [] }],
    }).load();
    assert.equal(library.status.available, true);
    assert.equal(library.root, path.join(source, "media"));
    assert.equal((await library.forTarget("7.19")).cover.id, asset);
    assert.deepEqual(
      await fs.readFile(path.join(backup, configured || "media", "index.json")),
      originalIndex,
    );
    assert.deepEqual(
      await files.readJson(
        path.join(backup, "sessions", "evidence", "state.json"),
      ),
      { preserve: true },
    );
  });
}

test("external media config is retained without reading or copying the unavailable external root", async (t) => {
  const { root, source, config } = await fixture(t);
  const externalRoot = path.join(root, "does-not-exist-external-media");
  const bytes = Buffer.from(
    "\ufeff" +
      JSON.stringify({ root: externalRoot, note: "preserve config bytes" }),
  );
  await fs.writeFile(path.join(source, "media.json"), bytes);
  await media(path.join(source, "media"));
  const target = await exportBindings(source, root, config);
  assert.deepEqual(await fs.readFile(path.join(target, "media.json")), bytes);
  assert.deepEqual(await fs.readFile(path.join(source, "media.json")), bytes);
  await assert.rejects(fs.stat(path.join(target, "media")), { code: "ENOENT" });
  await assert.rejects(fs.stat(externalRoot), { code: "ENOENT" });
  assert.match(
    await fs.readFile(
      path.join(target, "MEDIA-RECOVERY-INSTRUCTIONS.txt"),
      "utf8",
    ),
    /重新绑定本机实际媒体目录/,
  );
});

test("bad media config is rejected before export without replacing source evidence", async (t) => {
  const { root, source, config } = await fixture(t);
  const mediaConfig = path.join(source, "media.json");
  const before = await fs.readFile(
    path.join(source, "sessions", "evidence", "state.json"),
  );
  for (const bytes of [
    "{broken",
    "null",
    "[]",
    "{}",
    '{"root":"relative-root"}',
    '{"root":123}',
  ]) {
    await fs.writeFile(mediaConfig, bytes);
    await assert.rejects(
      exportBindings(source, root, config),
      /媒体配置无法导出/,
    );
    assert.equal(await fs.readFile(mediaConfig, "utf8"), bytes);
    assert.deepEqual(
      await fs.readFile(
        path.join(source, "sessions", "evidence", "state.json"),
      ),
      before,
    );
    assert.equal(
      (await fs.readdir(root)).filter((name) =>
        name.startsWith("data-recovery-"),
      ).length,
      0,
    );
  }
});

test("whole data and lifecycle evidence roots are refused instead of copied as media", async (t) => {
  const { root, source, config } = await fixture(t);
  for (const mediaRoot of [
    source,
    path.join(source, "sessions"),
    path.join(source, "client.lock"),
    path.join(source, "compat-backups", "nested"),
  ]) {
    await files.writeJson(path.join(source, "media.json"), { root: mediaRoot });
    await assert.rejects(
      exportBindings(source, root, config),
      /整个 data|租约证据目录/,
    );
    assert.equal(
      (await fs.readdir(root)).filter((name) =>
        name.startsWith("data-recovery-"),
      ).length,
      0,
    );
  }
  assert.deepEqual(
    await files.readJson(
      path.join(source, "sessions", "evidence", "state.json"),
    ),
    { preserve: true },
  );
  assert.ok((await fs.stat(path.join(source, "client.lock"))).isDirectory());
});

test("internal linked roots and nested linked directories preserve original files and abort export", async (t) => {
  const { root, source, config } = await fixture(t);
  const externalRoot = path.join(root, "real-media");
  await media(externalRoot);
  const originalIndex = await fs.readFile(
    path.join(externalRoot, "index.json"),
  );
  const linkedRoot = path.join(source, "linked-media");
  try {
    await fs.symlink(externalRoot, linkedRoot, "junction");
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES"].includes(error.code)
    ) {
      t.skip("Windows directory-link permission unavailable");
      return;
    }
    throw error;
  }
  await files.writeJson(path.join(source, "media.json"), { root: linkedRoot });
  await assert.rejects(
    exportBindings(source, root, config),
    /符号链接|目录联接/,
  );
  await files.writeJson(path.join(source, "media.json"), {
    root: path.join(source, "media"),
  });
  await fs.mkdir(path.join(source, "media"));
  await fs.symlink(
    externalRoot,
    path.join(source, "media", "linked-child"),
    "junction",
  );
  await assert.rejects(exportBindings(source, root, config), /媒体目录含链接/);
  assert.deepEqual(
    await fs.readFile(path.join(externalRoot, "index.json")),
    originalIndex,
  );
  for (const name of (await fs.readdir(root)).filter((name) =>
    name.startsWith("data-recovery-"),
  ))
    await assert.rejects(fs.stat(path.join(root, name, "library.json")), {
      code: "ENOENT",
    });
});

test("a broken internal index is preserved byte-for-byte and stays visibly unavailable", async (t) => {
  const { root, source, config } = await fixture(t);
  await fs.mkdir(path.join(source, "media"));
  const bytes = Buffer.from("{unreadable-index-evidence");
  await fs.writeFile(path.join(source, "media", "index.json"), bytes);
  const target = await exportBindings(source, root, config);
  assert.deepEqual(
    await fs.readFile(path.join(source, "media", "index.json")),
    bytes,
  );
  assert.deepEqual(
    await fs.readFile(path.join(target, "media", "index.json")),
    bytes,
  );
  const library = await new MediaLibrary(target, { entries: [] }).load();
  assert.equal(library.status.canImport, false);
  assert.match(library.status.error, /媒体索引不可用/);
});
