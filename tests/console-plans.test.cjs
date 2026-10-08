const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  plans = require("../src/backend/plans.cjs"),
  catalog = require("../resources/catalog.json");
const runtimeRoot = path.resolve("console-client-fixture"),
  packageFile = path.resolve("console-map-fixture.vpk"),
  options = {
    room: plans.roomOptions(),
    cfgName: "fixture.cfg",
    log: "fixture.log",
    packages: {},
    join: "192.168.1.25",
    prototypePassword: "a".repeat(48),
  };

test("all registered client entry routes enable the native console without exposing new control endpoints", () => {
  let clients = 0,
    events = 0;
  function check(entry, mode, event, extra = {}) {
    const args = plans.buildArgs(
      entry,
      mode,
      {
        root: runtimeRoot,
        event,
        packageFile: event?.category === "community" ? packageFile : undefined,
      },
      { ...options, ...extra },
    );
    assert.equal(
      args.filter((arg) => arg === "-console").length,
      1,
      entry.id + ":" + mode,
    );
    assert.equal(args[args.indexOf("+con_enable") + 1], "1");
    assert.equal(args.includes("+rcon_password"), false);
    assert.equal(
      args.includes("-vconsole"),
      !!extra.hostBootstrap && entry.source2 === true,
    );
    const controlExpected =
      !!extra.hostBootstrap || (!!entry.prototype && mode === "bots");
    assert.equal(args.includes("-netconport"), controlExpected);
    assert.equal(args.includes("-netconpassword"), controlExpected);
    if (entry.prototype && mode === "bots") {
      assert.equal(args[args.indexOf("-netconport") + 1], "27111");
      assert.equal(
        args[args.indexOf("-netconpassword") + 1],
        options.prototypePassword,
      );
    }
    return args;
  }
  for (const entry of catalog.entries) {
    if (!entry.playable && !entry.menuOnly) continue;
    check(entry, "menu");
    clients++;
    if (!entry.playable) {
      for (const mode of ["bots", "join"])
        assert.throws(() => check(entry, mode), /仅支持主菜单/);
      assert.throws(
        () => check(entry, "menu", undefined, { host: true }),
        /仅支持主菜单/,
      );
      continue;
    }
    check(entry, "bots");
    check(entry, "join");
    if (!entry.prototype) check(entry, "bots", undefined, { host: true });
    if (entry.listenHostBootstrap === true)
      check(entry, "bots", undefined, {
        host: true,
        hostBootstrap: { port: 50311, password: "b".repeat(64) },
      });
    for (const event of entry.events) {
      if (event.launchDisabledReason) continue;
      check(entry, event.id, event);
      check(entry, event.id, event, { host: true });
      const join = check(entry, "join", event, { joinMode: event.id });
      assert.equal(join.includes("+map"), false);
      assert.equal(join.includes("+dota_launch_custom_game"), false);
      events++;
    }
  }
  assert.equal(
    clients,
    catalog.entries.filter((e) => e.playable || e.menuOnly).length,
  );
  assert.equal(
    events,
    catalog.entries
      .flatMap((e) => e.events)
      .filter((e) => !e.launchDisabledReason).length,
  );
});

test("temporary console setup binds the alternate key then hides the console before loading any map", () => {
  let communityMaps = 0;
  function check(mode, event, host = false) {
    const cfg = plans.buildClientCfg({ mode, event, host, room: options.room }),
      lines = cfg.trimEnd().split("\n"),
      enable = lines.indexOf("con_enable 1"),
      bind = lines.indexOf("bind F8 toggleconsole"),
      hide = lines.indexOf("hideconsole"),
      map = lines.findIndex((line) => /^map\s/.test(line));
    assert.ok(enable >= 0 && enable < bind && bind < hide);
    assert.equal(lines.filter((line) => line === "hideconsole").length, 1);
    if (event?.category === "community" && mode !== "join") {
      assert.ok(map > hide, "console must be hidden before map loading begins");
      assert.match(lines[map], /gamemode=15.*nomapvalidation=1$/);
    } else assert.equal(map, -1);
    if (mode === "join") assert.ok(!/^\s*(?:map|sv_cheats)\b/m.test(cfg));
  }
  for (const mode of ["menu", "bots", "join"]) check(mode);
  check("bots", undefined, true);
  for (const entry of catalog.entries) {
    if (!entry.playable) continue;
    for (const event of entry.events) {
      if (event.launchDisabledReason) continue;
      check(event.id, event);
      check(event.id, event, true);
      check("join", event);
      if (event.category === "community") communityMaps++;
    }
    // Source 1 and normal Source 2 load maps via argv, after the temporary CFG.
    const args = plans.buildArgs(entry, "bots", { root: runtimeRoot }, options);
    assert.ok(args.indexOf("+exec") < args.indexOf("+map"));
  }
  assert.ok(communityMaps > 0);
});
