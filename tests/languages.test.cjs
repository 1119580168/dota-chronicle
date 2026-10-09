const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const {
  detectLanguages,
  parseVpkTree,
  languageCode,
} = require("../src/backend/languages.cjs");
const { Library } = require("../src/backend/library.cjs");
const { buildArgs, roomOptions } = require("../src/backend/plans.cjs");
const { hash } = require("../src/backend/files.cjs");
function tree(directory = "resource/localization", final = true) {
  const entry = Buffer.alloc(18);
  entry.writeUInt16LE(3, 4);
  entry.writeUInt16LE(65535, 16);
  return Buffer.concat([
    Buffer.from("txt\0" + directory + "\0dota_english\0"),
    entry,
    Buffer.from("abc"),
    Buffer.from("dota_schinese\0"),
    entry,
    Buffer.from("abc\0\0" + (final ? "\0" : "")),
  ]);
}
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-language-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "dota/resource"), { recursive: true });
  return root;
}
test("language detection reads loose resources and VPK v1/v2 localization with preload bytes", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    path.join(root, "dota/resource/dota_english.txt"),
    "English",
  );
  assert.deepEqual(
    (await detectLanguages({}, root)).languages.map((l) => l.code),
    ["english"],
  );
  for (const version of [1, 2]) {
    const data = tree("resource/localization", version !== 1),
      header = Buffer.alloc(version === 1 ? 12 : 28);
    header.writeUInt32LE(0x55aa1234, 0);
    header.writeUInt32LE(version, 4);
    header.writeUInt32LE(data.length, 8);
    await fs.writeFile(
      path.join(root, "dota/pak01_dir.vpk"),
      Buffer.concat([header, data]),
    );
    const detected = await detectLanguages({}, root);
    assert.deepEqual(
      detected.languages.map((l) => l.code),
      ["english", "schinese"],
    );
    assert.doesNotMatch(detected.languageNote, /不完整/);
  }
  assert.equal(parseVpkTree(tree("materials")).size, 0);
});
test("malformed VPK trees do not expose unavailable languages or allow unbounded reads", async (t) => {
  assert.throws(
    () => parseVpkTree(Buffer.from("txt\0resource\0dota_schinese\0")),
    /损坏/,
  );
  assert.throws(() => parseVpkTree(Buffer.from("unterminated")), /损坏/);
  const root = await fixture(t),
    header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(0x7fffffff, 8);
  await fs.writeFile(path.join(root, "dota/pak01_dir.vpk"), header);
  const detected = await detectLanguages({}, root);
  assert.deepEqual(
    detected.languages.map((l) => l.code),
    ["english"],
  );
  assert.match(detected.languageNote, /不完整/);
});
test("per-client language persists without changing rooms or bindings and rejects absent resources", async (t) => {
  const root = await fixture(t),
    data = path.join(root, "profile");
  await fs.writeFile(path.join(root, "dota.exe"), "fixture");
  await fs.writeFile(path.join(root, "dota/steam.inf"), "build fixture");
  for (const code of ["english", "schinese"])
    await fs.writeFile(
      path.join(root, "dota/resource/dota_" + code + ".txt"),
      code,
    );
  const e = {
    id: "fixture",
    playable: true,
    exe: "dota.exe",
    steamInf: "dota/steam.inf",
    sha: await hash(path.join(root, "dota/steam.inf")),
    events: [],
  };
  const library = await new Library({ entries: [e] }, data).load();
  await library.bind(e.id, root);
  const room = structuredClone(library.config.room);
  await library.setLaunchOptions({ id: e.id, language: "schinese" });
  const reloaded = await new Library({ entries: [e] }, data).load();
  assert.equal((await reloaded.launchOptionsFor(e.id)).language, "schinese");
  assert.deepEqual(reloaded.config.roots, { fixture: root });
  assert.deepEqual(reloaded.config.room, room);
  await assert.rejects(
    reloaded.setLaunchOptions({ id: e.id, language: "tchinese" }),
    /未包含/,
  );
  await assert.rejects(
    reloaded.setLaunchOptions({ id: e.id, language: "schinese;quit" }),
    /无效/,
  );
  await fs.unlink(path.join(root, "dota/resource/dota_schinese.txt"));
  assert.equal((await reloaded.launchOptionsFor(e.id)).language, "english");
});
test("language is a validated argument for menus, bots, activities, hosts and joining", () => {
  for (const value of [
    "",
    "schinese;quit",
    "-novid",
    "__proto__",
    "toString",
    null,
  ])
    assert.throws(() => languageCode(value), /无效/);
  const catalog = require("../resources/catalog.json"),
    runtime = { root: path.resolve("fixture") };
  const options = {
    language: "schinese",
    room: roomOptions(),
    log: "native.log",
    cfgName: "fixture.cfg",
    packages: {},
  };
  for (const id of ["6.80c", "7.00", "7.32"]) {
    const entry = catalog.entries.find((e) => e.id === id);
    for (const mode of ["menu", "bots", "join"]) {
      const args = buildArgs(entry, mode, runtime, {
        ...options,
        join: "127.0.0.1",
      });
      assert.equal(args[args.indexOf("-language") + 1], "schinese");
    }
    const args = buildArgs(entry, "bots", runtime, { ...options, host: true });
    assert.equal(args[args.indexOf("-language") + 1], "schinese");
  }
  const entry = catalog.entries.find((e) => e.id === "7.19"),
    event = entry.events[0];
  assert.ok(
    buildArgs(entry, event.id, { ...runtime, event }, options).includes(
      "schinese",
    ),
  );
});
