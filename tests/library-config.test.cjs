const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { Library } = require("../src/backend/library.cjs");
const { writeJson } = require("../src/backend/files.cjs");
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-config-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const library = new Library({ entries: [] }, dir);
  await writeJson(library.configFile, {
    schema: 1,
    roots: { fixture: path.join(dir, "client") },
    packages: {},
  });
  return library;
}
test("an access-probe failure cannot silently discard an existing binding file", async (t) => {
  const library = await fixture(t);
  t.mock.method(fs, "access", async () => {
    throw Object.assign(Error("blocked access probe"), { code: "EACCES" });
  });
  await library.load();
  assert.ok(library.config.roots.fixture);
});
test("transient read denial retries and permanent denial preserves loaded bindings", async (t) => {
  const library = await fixture(t);
  await library.load();
  const before = structuredClone(library.config),
    read = fs.readFile.bind(fs);
  let attempts = 0;
  const mock = t.mock.method(fs, "readFile", async (...args) => {
    if (args[0] === library.configFile && attempts++ === 0)
      throw Object.assign(Error("temporary denial"), { code: "EACCES" });
    return read(...args);
  });
  await library.load();
  assert.equal(attempts, 2);
  assert.deepEqual(library.config, before);
  mock.mock.restore();
  t.mock.method(fs, "readFile", async (...args) => {
    if (args[0] === library.configFile)
      throw Object.assign(Error("read blocked"), { code: "EPERM" });
    return read(...args);
  });
  await assert.rejects(library.load(), /无法读取客户端绑定配置.*EPERM/);
  assert.deepEqual(library.config, before);
});
test("invalid configuration is reported and revisions distinguish externally changed bindings", async (t) => {
  const library = await fixture(t);
  await library.load();
  const before = structuredClone(library.config),
    revision = library.revision;
  await fs.writeFile(library.configFile, "{ broken");
  assert.notEqual(await library.configRevision(), revision);
  await assert.rejects(library.load(), /格式错误/);
  assert.deepEqual(library.config, before);
  await fs.writeFile(library.configFile, "null");
  await assert.rejects(library.load(), /配置格式错误/);
  assert.deepEqual(library.config, before);
  await fs.unlink(library.configFile);
  await library.load();
  assert.deepEqual(library.config.roots, {});
  assert.equal(library.revision, "missing");
});
