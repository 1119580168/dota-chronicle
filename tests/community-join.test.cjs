const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const plans = require("../src/backend/plans.cjs"),
  files = require("../src/backend/files.cjs"),
  { Library } = require("../src/backend/library.cjs");

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-community-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "client"),
    packageFile = path.join(base, "original map.vpk");
  await fs.mkdir(path.join(root, "game/dota"), { recursive: true });
  await fs.writeFile(path.join(root, "dota2.exe"), "unlaunchable fixture");
  await fs.writeFile(path.join(root, "game/dota/steam.inf"), "client fixture");
  await fs.writeFile(packageFile, "fixed original package fixture");
  const event = {
      id: "fixture-rpg",
      version: "fixture",
      category: "community",
      kind: "native",
      map: "fixture_map",
      workshopId: "123456789",
      packageSha: await files.hash(packageFile),
    },
    entry = {
      id: "fixture",
      playable: true,
      source2: true,
      exe: "dota2.exe",
      steamInf: "game/dota/steam.inf",
      sha: await files.hash(path.join(root, "game/dota/steam.inf")),
      events: [event],
    };
  return {
    base,
    root,
    packageFile,
    event,
    entry,
    packages: { [event.id]: packageFile },
  };
}

test("community joins require the selected version's exact original package", async (t) => {
  const f = await fixture(t),
    runtime = await plans.inspect(
      f.entry,
      f.root,
      "join",
      f.packages,
      f.event.id,
    );
  assert.equal(runtime.event.id, f.event.id);
  assert.equal(runtime.packageFile, await fs.realpath(f.packageFile));
  await assert.rejects(
    plans.inspect(f.entry, f.root, "join", {}, f.event.id),
    /原始 VPK/,
  );
  await fs.writeFile(f.packageFile, "different package");
  await assert.rejects(
    plans.inspect(f.entry, f.root, "join", f.packages, f.event.id),
    /指纹/,
  );
});

test("joinMode defaults to ordinary games and rejects non-event or cross-version targets", async (t) => {
  const f = await fixture(t);
  assert.equal((await plans.inspect(f.entry, f.root, "join")).event, undefined);
  assert.equal(
    (await plans.inspect(f.entry, f.root, "join", f.packages, "bots")).event,
    undefined,
  );
  for (const joinMode of [
    "menu",
    "join",
    "other-version-map",
    "fixture-rpg;quit",
    "",
    null,
    7,
    {},
  ])
    await assert.rejects(
      plans.inspect(f.entry, f.root, "join", f.packages, joinMode),
      /不属于/,
    );
});

test("joining a community map mounts its VPK and connects without starting a local map", async (t) => {
  const f = await fixture(t),
    runtime = await plans.inspect(
      f.entry,
      f.root,
      "join",
      f.packages,
      f.event.id,
    ),
    room = plans.roomOptions({ port: 30324, password: "fixture-only" }),
    options = {
      room,
      cfgName: "fixture.cfg",
      log: "fixture.log",
      packages: f.packages,
      join: "192.168.1.25",
      joinMode: f.event.id,
    },
    args = plans.buildArgs(f.entry, "join", runtime, options),
    cfg = plans.buildClientCfg({ mode: "join", event: runtime.event, room });
  assert.equal(args[args.indexOf("-addon_path") + 1], runtime.packageFile);
  assert.equal(args[args.indexOf("+connect") + 1], "192.168.1.25:30324");
  assert.equal(args[args.indexOf("+password") + 1], "fixture-only");
  for (const command of [
    "+map",
    "+dota_launch_custom_game",
    "+dota_bot_practice_start",
  ])
    assert.equal(
      args.includes(command),
      false,
      command + " must not create a local game",
    );
  assert.ok(!/^\s*map\b/m.test(cfg));
  assert.ok(!/customgamemode=/.test(cfg));
  assert.match(cfg, /con_enable 1/);
  assert.throws(
    () =>
      plans.buildArgs(f.entry, "join", runtime, {
        ...options,
        joinMode: "bots",
      }),
    /尚未通过核验/,
  );
  assert.throws(
    () =>
      plans.buildArgs(f.entry, "join", runtime, {
        ...options,
        joinMode: "missing-event",
      }),
    /不属于/,
  );
  assert.throws(
    () =>
      plans.buildArgs(
        f.entry,
        "join",
        { ...runtime, event: undefined },
        options,
      ),
    /尚未通过核验/,
  );

  // Hosting retains the original map command and balance parameters.
  const hostCfg = plans.buildClientCfg({
    mode: f.event.id,
    event: f.event,
    host: true,
    room,
  });
  assert.match(hostCfg, /^sv_lan 1$/m);
  assert.match(
    hostCfg,
    /^map fixture_map gamemode=15 customgamemode=123456789 difficulty=0 nomapvalidation=1$/m,
  );

  // Older callers that provide no joinMode still connect to ordinary games.
  const ordinaryRuntime = await plans.inspect(f.entry, f.root, "join"),
    ordinaryArgs = plans.buildArgs(f.entry, "join", ordinaryRuntime, {
      ...options,
      joinMode: undefined,
    });
  assert.equal(ordinaryArgs.includes("-addon_path"), false);
  assert.equal(ordinaryArgs.includes("+map"), false);
  assert.equal(
    ordinaryArgs[ordinaryArgs.indexOf("+connect") + 1],
    "192.168.1.25:30324",
  );
});

test("official event joins validate their map components without a local launch", async (t) => {
  const f = await fixture(t),
    event = {
      id: "official-fixture",
      category: "official",
      addon: "test_addon",
      map: "test_map",
    },
    entry = { ...f.entry, events: [event] };
  await assert.rejects(
    plans.inspect(entry, f.root, "join", {}, event.id),
    /缺少活动地图/,
  );
  const map = path.join(
    f.root,
    "game/dota_addons/test_addon/maps/test_map.vpk",
  );
  await fs.mkdir(path.dirname(map), { recursive: true });
  await fs.writeFile(map, "map component fixture");
  const runtime = await plans.inspect(entry, f.root, "join", {}, event.id),
    args = plans.buildArgs(entry, "join", runtime, {
      room: plans.roomOptions(),
      cfgName: "fixture.cfg",
      log: "fixture.log",
      packages: {},
      join: "192.168.1.25",
      joinMode: event.id,
    });
  assert.equal(args.includes("+dota_launch_custom_game"), false);
  assert.equal(args.includes("+map"), false);
  assert.equal(args.includes("+connect"), true);
  assert.ok(
    !/^\s*map\b/m.test(
      plans.buildClientCfg({ mode: "join", event, room: plans.roomOptions() }),
    ),
  );
});

test("package binding and launch inspection reject relative paths, folders and altered files", async (t) => {
  const f = await fixture(t),
    data = path.join(f.base, "isolated-data"),
    library = new Library({ entries: [f.entry] }, data),
    folder = path.join(f.base, "directory.vpk"),
    wrong = path.join(f.base, "wrong.vpk");
  await fs.mkdir(folder);
  await fs.writeFile(wrong, "wrong bytes");
  for (const [file, error] of [
    ["relative.vpk", /绝对路径/],
    [folder, /普通 VPK/],
    [wrong, /指纹/],
  ]) {
    await assert.rejects(library.package(f.event.id, file), error);
    await assert.rejects(
      plans.inspect(
        f.entry,
        f.root,
        "join",
        { [f.event.id]: file },
        f.event.id,
      ),
      error,
    );
  }
  assert.equal(
    await files.exists(library.configFile),
    false,
    "rejections must not save bindings",
  );
  await library.package(f.event.id, f.packageFile);
  assert.equal(
    library.config.packages[f.event.id],
    await fs.realpath(f.packageFile),
  );
  const saved = await fs.readFile(library.configFile, "utf8");
  await assert.rejects(library.package(f.event.id, wrong), /指纹/);
  assert.equal(
    await fs.readFile(library.configFile, "utf8"),
    saved,
    "a rejected replacement preserves the original binding",
  );
});

test("package binding and launch inspection refuse linked files or parent directories", async (t) => {
  const f = await fixture(t),
    library = new Library({ entries: [f.entry] }, path.join(f.base, "data")),
    link = path.join(f.base, "linked-file.vpk"),
    linkedParent = path.join(f.base, "linked-parent");
  // Windows permits directory junctions without requiring developer mode.
  await fs.symlink(
    path.dirname(f.packageFile),
    linkedParent,
    process.platform === "win32" ? "junction" : "dir",
  );
  const throughParent = path.join(linkedParent, path.basename(f.packageFile));
  await assert.rejects(
    library.package(f.event.id, throughParent),
    /不支持符号链接或目录联接/,
  );
  await assert.rejects(
    plans.inspect(
      f.entry,
      f.root,
      "join",
      { [f.event.id]: throughParent },
      f.event.id,
    ),
    /不支持符号链接或目录联接/,
  );
  try {
    await fs.symlink(f.packageFile, link, "file");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.diagnostic(
        "File symlink requires Windows developer mode; parent-junction rejection was checked.",
      );
      return;
    }
    throw error;
  }
  await assert.rejects(
    library.package(f.event.id, link),
    /不支持符号链接或目录联接/,
  );
  await assert.rejects(
    plans.inspect(f.entry, f.root, "join", { [f.event.id]: link }, f.event.id),
    /不支持符号链接或目录联接/,
  );
});
