const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const plans = require("../src/backend/plans.cjs");
const files = require("../src/backend/files.cjs");
const lease = require("../src/backend/leases.cjs");
const catalog = require("../resources/catalog.json");
test("Reject command injection, invalid addresses, ports and path escapes", () => {
  for (const port of [0, 65535, 30323.5, "1;quit"])
    assert.throws(() => plans.roomOptions({ port }));
  for (const password of ['a";quit', "hello\nquit", "中文", ""])
    assert.throws(() => plans.roomOptions({ password }));
  for (const ip of ["127.0.0.1;quit", "999.1.1.1", "$(whoami)", "a\nquit"])
    assert.throws(() => plans.serverAddress(ip));
  assert.equal(plans.serverAddress("192.168.1.25"), "192.168.1.25");
  assert.throws(() => files.inside(os.tmpdir(), "../outside"));
  assert.throws(() => files.inside(os.tmpdir(), path.resolve(os.tmpdir())));
});
test("LAN host leaves human slots, single-player keeps vetted bot entry, correct nian3", () => {
  const e = catalog.entries.find((e) => e.id === "7.19"),
    runtime = { root: path.resolve("example") };
  const options = {
    room: plans.roomOptions(),
    log: "native.log",
    cfgName: "test.cfg",
    packages: {},
  };
  const local = plans.buildArgs(e, "bots", runtime, options);
  assert.ok(local.includes("+dota_bot_practice_start"));
  assert.equal(local[local.indexOf("-ip") + 1], "127.0.0.1");
  const lan = plans.buildArgs(e, "bots", runtime, { ...options, host: true });
  assert.ok(!lan.includes("+dota_bot_practice_start"));
  assert.equal(lan[lan.indexOf("-ip") + 1], "0.0.0.0");
  assert.ok(lan.includes("+dev_block_gc_hello"));
  assert.ok(!lan.includes("-netconport"));
  assert.ok(!lan.includes("+rcon_password"));
  const s1 = catalog.entries.find((e) => e.id === "6.80c"),
    event = s1.events.find((e) => e.id === "nian2014");
  const args = plans.buildArgs(s1, event.id, { ...runtime, event }, options);
  assert.equal(args[args.indexOf("+map") + 1], "nian3");
  assert.ok(!args.includes("+dota_launch_custom_game"));
});
test("Wrong build is rejected before any launch or mutation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "dota"));
  await fs.writeFile(path.join(root, "dota.exe"), "fixture");
  await fs.writeFile(path.join(root, "dota/steam.inf"), "wrong");
  await assert.rejects(
    plans.inspect(
      catalog.entries.find((e) => e.id === "6.80c"),
      root,
    ),
    /构建/,
  );
  await assert.rejects(
    plans.inspect(
      catalog.entries.find((e) => e.id === "2011"),
      root,
      "bots",
    ),
    /组件/,
  );
});
test("Menu-only archives validate their build and never expose matches or hosting", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-menu-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "dota"));
  await fs.writeFile(path.join(root, "dota.exe"), "menu fixture");
  await fs.writeFile(path.join(root, "dota/steam.inf"), "archive fixture");
  const entry = {
    ...catalog.entries.find((e) => e.id === "2011"),
    sha: await files.hash(path.join(root, "dota/steam.inf")),
  };
  const runtime = await plans.inspect(entry, root, "menu");
  assert.equal(runtime.exe, path.join(root, "dota.exe"));
  const options = {
    room: plans.roomOptions(),
    log: "native.log",
    cfgName: "test.cfg",
    packages: {},
  };
  const args = plans.buildArgs(entry, "menu", runtime, options);
  assert.ok(!args.includes("+map"));
  assert.ok(!args.includes("+connect"));
  assert.ok(!args.includes("+dota_bot_practice_start"));
  assert.throws(
    () => plans.buildArgs(entry, "menu", runtime, { ...options, host: true }),
    /仅支持主菜单/,
  );
  for (const mode of ["bots", "join", "nian2014"]) {
    await assert.rejects(plans.inspect(entry, root, mode), /缺少比赛组件/);
    assert.throws(
      () => plans.buildArgs(entry, mode, runtime, options),
      /仅支持主菜单/,
    );
  }
  await assert.rejects(
    plans.inspect({ ...entry, menuOnly: false }, root),
    /缺少比赛组件/,
  );
  await fs.writeFile(path.join(root, "dota/steam.inf"), "other build");
  await assert.rejects(plans.inspect(entry, root, "menu"), /构建/);
});
test("Steam route restores original including an originally missing value; preserves external changes", async () => {
  let current = { exists: true, value: "official.dll" },
    writes = [];
  const windows = {
    registryRead: async () => current,
    registryWrite: async (n, v) => writes.push([n, v]),
  };
  const state = {
    route: {
      name: "SteamClientDll",
      candidate: "official.dll",
      original: { exists: false },
    },
  };
  await lease.restoreRegistry(state, windows);
  assert.deepEqual(writes, [["SteamClientDll", { exists: false }]]);
  current = { exists: true, value: "other-app.dll" };
  writes = [];
  const changed = {
    route: {
      name: "SteamClientDll",
      candidate: "official.dll",
      original: { exists: true, value: "old.dll", kind: "String" },
    },
  };
  await lease.restoreRegistry(changed, windows);
  assert.equal(writes.length, 0);
  assert.equal(changed.route.externalChangePreserved, true);
});
test("Addon isolation restores original bytes and never overwrites external files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-addon-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, "dota/addons/frostivus");
  await fs.mkdir(original, { recursive: true });
  await fs.writeFile(path.join(original, "test.lua"), "original");
  const state = {
    id: "test-case",
    root,
    entry: { id: "6.80c" },
    event: { addon: "nian" },
  };
  await lease.prepareAddon(state, async () => {});
  assert.equal(await files.exists(original), false);
  await lease.restoreAddon(state);
  assert.equal(
    await fs.readFile(path.join(original, "test.lua"), "utf8"),
    "original",
  );
  state.addon = null;
  await lease.prepareAddon(state, async () => {});
  await fs.mkdir(original);
  await fs.writeFile(path.join(original, "new.lua"), "external");
  await assert.rejects(lease.restoreAddon(state), /外部修改/);
  assert.equal(
    await fs.readFile(path.join(original, "new.lua"), "utf8"),
    "external",
  );
  assert.equal(await files.exists(state.addon.to), true);
});
test("Modified generated CFG is preserved during cleanup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-cfg-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = path.join(root, "dota/cfg/chronicle_case.cfg");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, "owned");
  const state = {
    id: "case",
    root,
    entry: { source2: false },
    cfg: { path: p, sha: await files.hash(p) },
  };
  await fs.writeFile(p, "external");
  await lease.restoreCfg(state);
  assert.equal(await fs.readFile(p, "utf8"), "external");
  assert.ok(state.cfg.externalChangePreserved);
});
test("Cross-version event selection is rejected", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-map-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "dota"));
  await fs.writeFile(path.join(root, "dota.exe"), "fixture");
  await fs.writeFile(path.join(root, "dota/steam.inf"), "correct fixture");
  const e = {
    playable: true,
    exe: "dota.exe",
    steamInf: "dota/steam.inf",
    sha: await files.hash(path.join(root, "dota/steam.inf")),
    events: [],
  };
  await assert.rejects(plans.inspect(e, root, "aghanim2"), /不属于/);
});
