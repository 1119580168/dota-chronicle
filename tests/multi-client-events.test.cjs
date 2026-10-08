const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const files = require("../src/backend/files.cjs"),
  plans = require("../src/backend/plans.cjs"),
  { Library } = require("../src/backend/library.cjs"),
  {
    validateEventCatalog,
    trustedEntryForSession,
    catalogFile,
  } = require("../src/backend/event-catalog.cjs");

async function fixture(t) {
  const base = await fs.mkdtemp(
    path.join(os.tmpdir(), "chronicle-multiclient-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const packageFile = path.join(base, "original.vpk");
  await fs.writeFile(packageFile, "unchanged original map package");
  const originalSha = await files.hash(packageFile),
    entries = [],
    roots = {};
  for (const [index, id] of ["client-a", "client-b"].entries()) {
    const root = path.join(base, id);
    await fs.mkdir(path.join(root, "game/dota/resource"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dota2.exe"),
      "unlaunchable test fixture",
    );
    await fs.writeFile(path.join(root, "game/dota/steam.inf"), id + " build");
    await fs.writeFile(
      path.join(root, "game/dota/resource/dota_schinese.txt"),
      "fixture",
    );
    entries.push({
      id,
      playable: true,
      source2: true,
      exe: "dota2.exe",
      steamInf: "game/dota/steam.inf",
      sha: await files.hash(path.join(root, "game/dota/steam.inf")),
      events: [
        {
          id: "shared-rpg",
          version: id,
          category: "community",
          kind: "native",
          map: "shared_map",
          workshopId: "123456789",
          packageSha: originalSha,
          requiresCheats: true,
          verified: index ? "此客户端尚未试玩" : "此客户端基础试玩通过",
        },
      ],
    });
    roots[id] = root;
  }
  const catalog = { entries },
    library = new Library(catalog, path.join(base, "isolated-data"));
  return { base, packageFile, originalSha, catalog, library, roots };
}

test("one fixed package binding serves multiple verified clients without inheriting gameplay acceptance", async (t) => {
  const f = await fixture(t);
  await f.library.package("shared-rpg", f.packageFile);
  for (const entry of f.catalog.entries)
    await f.library.bind(entry.id, f.roots[entry.id]);
  await f.library.setLaunchOptions({ id: "client-a", language: "schinese" });
  const snapshot = await f.library.snapshot();
  assert.equal(Object.keys(f.library.config.packages).length, 1);
  assert.deepEqual(
    snapshot.entries.map((e) => e.events[0].available),
    [true, true],
  );
  assert.deepEqual(
    snapshot.entries.map((e) => e.events[0].verified),
    ["此客户端基础试玩通过", "此客户端尚未试玩"],
  );
  assert.deepEqual(
    snapshot.entries.map((e) => e.language),
    ["schinese", "english"],
  );
  for (const entry of f.catalog.entries) {
    const runtime = await plans.inspect(
      entry,
      f.roots[entry.id],
      "shared-rpg",
      f.library.config.packages,
    );
    assert.equal(runtime.packageFile, await fs.realpath(f.packageFile));
    assert.equal(runtime.event.version, entry.id);
    assert.equal(runtime.root, await fs.realpath(f.roots[entry.id]));
  }
  assert.equal(await files.hash(f.packageFile), f.originalSha);
});

test("shared ids reject changed SHA, Workshop identity, map, owner or unsupported runtimes before binding", async (t) => {
  const f = await fixture(t);
  for (const [label, mutate] of [
    ["sha", (e) => (e.events[0].packageSha = "f".repeat(64))],
    ["workshop", (e) => (e.events[0].workshopId = "987654321")],
    ["map", (e) => (e.events[0].map = "other_map")],
    ["owner", (e) => (e.events[0].version = "client-a")],
    ["official", (e) => (e.events[0].category = "official")],
    ["source1", (e) => (e.source2 = false)],
    ["prototype", (e) => (e.prototype = true)],
    ["menu only", (e) => (e.playable = false)],
  ]) {
    const changed = structuredClone(f.catalog);
    mutate(changed.entries[1]);
    assert.throws(() => validateEventCatalog(changed), undefined, label);
    assert.throws(
      () => new Library(changed, path.join(f.base, label)),
      undefined,
      label,
    );
  }
  await f.library.package("shared-rpg", f.packageFile);
  const saved = await fs.readFile(f.library.configFile, "utf8");
  f.catalog.entries[1].events[0].packageSha = "f".repeat(64);
  await assert.rejects(
    f.library.package("shared-rpg", f.packageFile),
    /同一游廊原包/,
  );
  assert.equal(await fs.readFile(f.library.configFile, "utf8"), saved);
});

test("white lists refuse duplicate official routes, same-client duplicates and malformed tooling fields", () => {
  const event = { id: "official", version: "a", category: "official" },
    entries = [
      { id: "a", events: [event] },
      { id: "b", events: [{ ...event, version: "b" }] },
    ];
  assert.throws(() => validateEventCatalog({ entries }), /跨客户端/);
  assert.throws(
    () =>
      validateEventCatalog({ entries: [{ id: "a", events: [event, event] }] }),
    /重复入口/,
  );
  for (const fields of [
    { requiresCheats: "true" },
    { requiresCheats: true },
    { launchDisabledReason: true },
  ])
    assert.throws(() =>
      validateEventCatalog({
        entries: [{ id: "a", events: [{ ...event, ...fields }] }],
      }),
    );
});

test("failed client compatibility stays visible but refuses solo, host and join while other routes work", async (t) => {
  const f = await fixture(t),
    packages = { "shared-rpg": f.packageFile };
  f.catalog.entries[1].events[0].launchDisabledReason = "已实测地图加载失败";
  await f.library.package("shared-rpg", f.packageFile);
  for (const entry of f.catalog.entries)
    await f.library.bind(entry.id, f.roots[entry.id]);
  const snapshot = await f.library.snapshot(),
    [good, failed] = f.catalog.entries;
  assert.equal(snapshot.entries[1].installed, true);
  assert.equal(snapshot.entries[1].events[0].available, false);
  assert.match(snapshot.entries[1].events[0].note, /已实测地图加载失败/);
  assert.equal(snapshot.entries[0].events[0].available, true);
  for (const mode of ["shared-rpg", "join"]) {
    await assert.rejects(
      plans.inspect(failed, f.roots[failed.id], mode, packages, "shared-rpg"),
      /已禁用/,
    );
    await plans.inspect(good, f.roots[good.id], mode, packages, "shared-rpg");
  }
  for (const mode of ["menu", "bots"]) {
    await plans.inspect(failed, f.roots[failed.id], mode, packages);
    assert.equal(
      trustedEntryForSession(f.catalog, { entry: failed, mode }),
      failed,
    );
  }
  const room = plans.roomOptions(),
    options = {
      room,
      host: true,
      cfgName: "fixture.cfg",
      log: "fixture.log",
      packages,
    };
  // Clearing the stale runtime copy cannot evade the current authoring restriction.
  const stale = { ...failed.events[0], launchDisabledReason: "" };
  assert.throws(
    () =>
      plans.buildArgs(
        failed,
        stale.id,
        {
          root: f.roots[failed.id],
          event: stale,
          packageFile: f.packageFile,
        },
        options,
      ),
    /已禁用/,
  );
  assert.throws(
    () =>
      plans.buildClientCfg({
        mode: failed.events[0].id,
        event: failed.events[0],
        host: true,
        room,
      }),
    /已禁用/,
  );
  assert.throws(
    () =>
      trustedEntryForSession(f.catalog, {
        entry: failed,
        mode: "shared-rpg",
        host: true,
      }),
    /已禁用/,
  );
  assert.throws(
    () =>
      trustedEntryForSession(f.catalog, {
        entry: failed,
        mode: "join",
        joinMode: "shared-rpg",
      }),
    /已禁用/,
  );
});

test("selected client fingerprint and map whitelist are mandatory for every new route", async (t) => {
  const f = await fixture(t),
    [a, b] = f.catalog.entries;
  await assert.rejects(
    plans.inspect(b, f.roots[a.id], "shared-rpg", {
      "shared-rpg": f.packageFile,
    }),
    /构建/,
  );
  for (const request of [
    { entry: { id: "not-whitelisted", playable: true }, mode: "shared-rpg" },
    { entry: a, mode: "arbitrary-map" },
    { entry: a, mode: "join", joinMode: "arbitrary-map" },
    { entry: a, mode: "join", joinMode: null },
  ])
    assert.throws(
      () => trustedEntryForSession(f.catalog, request),
      /白名单|不属于/,
    );
  const fabricated = {
    ...a,
    exe: "arbitrary.exe",
    sha: "f".repeat(64),
    events: [{ id: "arbitrary-map", requiresCheats: true }],
  };
  assert.equal(
    trustedEntryForSession(f.catalog, {
      entry: fabricated,
      event: fabricated.events[0],
      mode: "shared-rpg",
    }),
    a,
    "the guardian selects the trusted catalog record, never the queued entry copy",
  );
  assert.throws(
    () =>
      trustedEntryForSession(f.catalog, {
        entry: fabricated,
        mode: "arbitrary-map",
      }),
    /不属于/,
  );
  const noRoute = { ...b, id: "other-client", events: [] };
  assert.throws(
    () =>
      trustedEntryForSession(
        { entries: [a, noRoute] },
        {
          entry: noRoute,
          mode: "shared-rpg",
        },
      ),
    /不属于/,
  );
});

test("map tooling, original VPK mount and per-client language work in solo/host but join never starts a map", async (t) => {
  const f = await fixture(t),
    room = plans.roomOptions({ port: 30324 }),
    packages = { "shared-rpg": f.packageFile };
  for (const entry of f.catalog.entries) {
    const runtime = await plans.inspect(
        entry,
        f.roots[entry.id],
        "shared-rpg",
        packages,
      ),
      options = {
        room,
        cfgName: "fixture.cfg",
        log: "fixture.log",
        packages,
        language: "schinese",
      };
    for (const host of [false, true]) {
      const cfg = plans.buildClientCfg({
          mode: "shared-rpg",
          event: runtime.event,
          host,
          room,
        }),
        args = plans.buildArgs(entry, "shared-rpg", runtime, {
          ...options,
          host,
        });
      assert.match(cfg, /^sv_cheats 1$/m);
      assert.match(
        cfg,
        /^map shared_map gamemode=15 customgamemode=123456789 difficulty=0 nomapvalidation=1$/m,
      );
      assert.equal(args[args.indexOf("-addon_path") + 1], runtime.packageFile);
      assert.equal(
        args[args.indexOf("-game") + 1],
        path.join(runtime.root, "game/dota"),
      );
      assert.equal(args[args.indexOf("-language") + 1], "schinese");
    }
    const joined = await plans.inspect(
        entry,
        f.roots[entry.id],
        "join",
        packages,
        "shared-rpg",
      ),
      joinCfg = plans.buildClientCfg({
        mode: "join",
        event: joined.event,
        room,
      }),
      joinArgs = plans.buildArgs(entry, "join", joined, {
        ...options,
        joinMode: "shared-rpg",
        join: "192.168.1.25",
      });
    assert.ok(!/^\s*(?:map|sv_cheats)\b/m.test(joinCfg));
    assert.equal(joinArgs.includes("+map"), false);
    assert.equal(joinArgs.includes("+dota_launch_custom_game"), false);
    assert.equal(
      joinArgs[joinArgs.indexOf("-addon_path") + 1],
      runtime.packageFile,
    );
    assert.equal(joinArgs[joinArgs.indexOf("-language") + 1], "schinese");
    assert.equal(
      joinArgs[joinArgs.indexOf("+connect") + 1],
      "192.168.1.25:30324",
    );
    assert.ok(
      !/^sv_cheats 1$/m.test(plans.buildClientCfg({ mode: "bots", room })),
    );
    assert.ok(
      !/^sv_cheats 1$/m.test(
        plans.buildClientCfg({ mode: "bots", event: joined.event, room }),
      ),
    );
    assert.ok(
      !/^sv_cheats 1$/m.test(
        plans.buildClientCfg({
          mode: "shared-rpg",
          event: { ...joined.event, requiresCheats: false },
          room,
        }),
      ),
    );
  }
  assert.equal(await files.hash(f.packageFile), f.originalSha);
});

test("guardian whitelist path resolves source and unpacked releases without a session-controlled location", () => {
  const source = path.resolve("fixture/src/backend"),
    unpacked = path.resolve("fixture/resources/app.asar.unpacked/src/backend");
  assert.equal(
    catalogFile(source),
    path.resolve("fixture/resources/catalog.json"),
  );
  assert.equal(
    catalogFile(unpacked),
    path.resolve("fixture/resources/app.asar/resources/catalog.json"),
  );
});
