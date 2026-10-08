const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { dataDirectory, prepareStorage } = require("../src/backend/storage.cjs");
const { writeJson } = require("../src/backend/files.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-storage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    legacy: path.join(root, "legacy"),
    target: path.join(root, "portable"),
  };
}

test("packaged storage is independent of AppData and explicit profiles remain isolated", () => {
  const executable = path.resolve("fixture", "Dota Chronicle.exe");
  const inputs = {
    packaged: true,
    executable,
    appData: path.resolve("package-appdata"),
  };
  assert.equal(
    dataDirectory(inputs),
    path.join(path.dirname(executable), "data"),
  );
  assert.equal(
    dataDirectory({ ...inputs, appData: path.resolve("desktop-appdata") }),
    dataDirectory(inputs),
  );
  assert.equal(
    dataDirectory({ ...inputs, override: "isolated-test" }),
    path.resolve("isolated-test"),
  );
  assert.equal(
    dataDirectory({ ...inputs, packaged: false }),
    path.join(inputs.appData, "Dota Chronicle"),
  );
});

test("legacy binding, media and completed session data migrate without overwriting portable settings", async (t) => {
  const { legacy, target } = await fixture(t);
  const session = "a1234567-1234-1234-1234-123456789012";
  await writeJson(path.join(legacy, "library.json"), {
    roots: { fixture: "client" },
  });
  await writeJson(path.join(legacy, "media.json"), { root: "external-media" });
  await writeJson(path.join(legacy, "media", "index.json"), { schema: 1 });
  await writeJson(path.join(legacy, "sessions", session, "state.json"), {
    stage: "finished",
  });
  await prepareStorage(target, legacy);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(target, "library.json"))),
    { roots: { fixture: "client" } },
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(target, "media.json"))),
    { root: "external-media" },
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(target, "media", "index.json"))),
    { schema: 1 },
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(target, "sessions", session, "state.json")),
    ).stage,
    "finished",
  );
  await writeJson(path.join(target, "library.json"), {
    roots: { updated: "new-client" },
  });
  await prepareStorage(target, legacy);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(target, "library.json"))),
    { roots: { updated: "new-client" } },
  );
});

test("an interrupted migration resumes and preserves files already present", async (t) => {
  const { legacy, target } = await fixture(t);
  await writeJson(path.join(legacy, "library.json"), {
    roots: { fixture: "client" },
  });
  await writeJson(path.join(legacy, "media.json"), { root: "old-media" });
  await writeJson(path.join(target, "media.json"), { root: "new-media" });
  await prepareStorage(target, legacy);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(target, "media.json"))).root,
    "new-media",
  );
  assert.ok(
    JSON.parse(await fs.readFile(path.join(target, "library.json"))).roots
      .fixture,
  );
});

test("active legacy sessions prevent migration before any binding is written", async (t) => {
  const { legacy, target } = await fixture(t);
  await writeJson(path.join(legacy, "library.json"), {
    roots: { fixture: "client" },
  });
  await writeJson(
    path.join(
      legacy,
      "sessions",
      "a1234567-1234-1234-1234-123456789012",
      "state.json",
    ),
    { stage: "running" },
  );
  await assert.rejects(prepareStorage(target, legacy), /尚未结束或恢复/);
  await assert.rejects(fs.stat(path.join(target, "library.json")), {
    code: "ENOENT",
  });
});

test("an explicit empty profile does not import bindings from any legacy profile", async (t) => {
  const { legacy, target } = await fixture(t);
  await writeJson(path.join(legacy, "library.json"), {
    roots: { fixture: "client" },
  });
  await prepareStorage(target, null);
  await assert.rejects(fs.stat(path.join(target, "library.json")), {
    code: "ENOENT",
  });
});
