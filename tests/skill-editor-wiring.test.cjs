const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path"),
  vm = require("node:vm"),
  catalog = require("../resources/catalog.json"),
  plans = require("../src/backend/plans.cjs"),
  files = require("../src/backend/files.cjs"),
  events = require("../src/backend/event-catalog.cjs");
const client = catalog.entries.find((entry) => entry.id === "7.22"),
  runtime = { root: path.resolve("unlaunchable-skills-fixture") },
  control = { port: 50423, password: "a".repeat(64) },
  options = {
    room: plans.roomOptions(),
    cfgName: "fixture.cfg",
    log: "fixture.log",
    packages: {},
    language: "schinese",
    skillBootstrap: control,
  };

test("only the canonical 7.22 feature route permits the single-player skills mode", () => {
  assert.deepEqual(
    catalog.entries.filter(events.allowsSkillEditor).map((entry) => entry.id),
    ["7.22"],
  );
  assert.equal(
    events.trustedEntryForSession(catalog, {
      entry: { id: "7.22", exe: "untrusted.exe" },
      type: "client",
      mode: "skills",
    }),
    client,
  );
  for (const entry of catalog.entries.filter((entry) => entry !== client)) {
    const fabricated = { ...entry, skillEditor: "722-v1", build: "3504" };
    assert.throws(() =>
      events.trustedEntryForSession(catalog, {
        entry: fabricated,
        mode: "skills",
        type: "client",
      }),
    );
    assert.throws(() => plans.buildArgs(entry, "skills", runtime, options));
    assert.throws(() => events.validateEventCatalog({ entries: [fabricated] }));
  }
  for (const request of [
    { host: true },
    { type: "dedicated" },
    { type: "arbitrary" },
  ]) {
    assert.throws(() =>
      events.trustedEntryForSession(catalog, {
        entry: client,
        mode: "skills",
        ...request,
      }),
    );
    assert.throws(() =>
      plans.buildArgs(client, "skills", runtime, { ...options, ...request }),
    );
  }
  for (const invalid of [
    { skillEditor: "different-tool" },
    { skillEditor: undefined },
    { build: "3505" },
    { source2: false },
    { playable: false },
    { prototype: true },
  ]) {
    assert.equal(events.allowsSkillEditor({ ...client, ...invalid }), false);
    assert.throws(() =>
      plans.buildArgs({ ...client, ...invalid }, "skills", runtime, options),
    );
  }
  assert.throws(() =>
    events.validateEventCatalog({
      entries: [{ ...client, events: [{ id: "skills", version: client.id }] }],
    }),
  );
  assert.throws(() =>
    events.trustedEntryForSession(catalog, {
      entry: client,
      mode: "join",
      joinMode: "skills",
    }),
  );
});

test("skills still requires a verified bound build and resolves to menu without any map", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "game/dota"), { recursive: true });
  await fs.mkdir(path.join(root, "game/bin/win64"), { recursive: true });
  await fs.writeFile(path.join(root, client.exe), "unlaunchable fixture");
  await fs.writeFile(path.join(root, client.steamInf), "fixture build");
  await assert.rejects(plans.inspect(client, root, "skills"), /构建/);
  const fixture = {
    ...client,
    sha: await files.hash(path.join(root, client.steamInf)),
  };
  const inspected = await plans.inspect(fixture, root, "skills");
  assert.equal(inspected.event, undefined);
  assert.equal(inspected.packageFile, undefined);
  assert.equal(inspected.root, await fs.realpath(root));
  await assert.rejects(plans.inspect(client, undefined, "skills"), /绑定/);
});

test("skills authentication and temporary cheats stay inside the dedicated menu route", () => {
  const args = plans.buildArgs(client, "skills", runtime, options),
    cfg = plans.buildClientCfg({ entry: client, mode: "skills", host: false });
  for (const flag of [
    "-console",
    "-vconsole",
    "-netconport",
    "-netconpassword",
  ])
    assert.equal(args.filter((item) => item === flag).length, 1);
  assert.equal(args[args.indexOf("-netconport") + 1], String(control.port));
  assert.equal(args[args.indexOf("-netconpassword") + 1], control.password);
  assert.equal(args[args.indexOf("-ip") + 1], "127.0.0.1");
  assert.equal(args[args.indexOf("-language") + 1], "schinese");
  for (const flag of [
    "+map",
    "+connect",
    "+dota_bot_practice_start",
    "+dota_launch_custom_game",
    "-addon_path",
    "+rcon_password",
  ])
    assert.equal(args.includes(flag), false, flag);
  assert.match(cfg, /^sv_cheats 1$/m);
  assert.ok(cfg.indexOf("hideconsole") < cfg.indexOf("sv_cheats 1"));
  assert.doesNotMatch(cfg, /^\s*(?:map|script|dota_launch_custom_game)\b/m);
  assert.doesNotMatch(cfg, /netcon|[a-f0-9]{64}/);
  assert.throws(() =>
    plans.buildArgs(client, "skills", runtime, {
      ...options,
      skillBootstrap: undefined,
    }),
  );
  for (const invalid of [
    { port: 0 },
    { port: 65535 },
    { port: 30323.5 },
    { port: "50423" },
    { password: "a".repeat(63) },
    { password: "g".repeat(64) },
    { password: "a\nquit" },
  ])
    assert.throws(() =>
      plans.buildArgs(client, "skills", runtime, {
        ...options,
        skillBootstrap: { ...control, ...invalid },
      }),
    );
  for (const mode of [
    "menu",
    "bots",
    "join",
    ...client.events.map((e) => e.id),
  ]) {
    assert.throws(() => plans.buildArgs(client, mode, runtime, options));
    if (mode === "menu" || mode === "bots" || mode === "join") {
      assert.doesNotMatch(
        plans.buildClientCfg({ entry: client, mode }),
        /^sv_cheats 1$/m,
      );
      const ordinary = plans.buildArgs(client, mode, runtime, {
        ...options,
        skillBootstrap: undefined,
        join: "192.168.1.25",
      });
      assert.equal(ordinary.includes("-netconport"), false);
      assert.equal(ordinary.includes("-vconsole"), false);
    }
  }
  const event = client.events[0];
  assert.throws(() =>
    plans.buildArgs(client, "skills", { ...runtime, event }, options),
  );
  assert.throws(() =>
    plans.buildClientCfg({ entry: client, mode: "skills", event }),
  );
});

async function workerHarness() {
  const source = await fs.readFile(
      path.join(__dirname, "../src/backend/worker.cjs"),
      "utf8",
    ),
    start = source.indexOf("async function ownsControlPort("),
    end = source.indexOf("async function prototypeStart(", start);
  assert.ok(start >= 0 && end > start);
  let exit, rejectTool, resolveTool;
  const state = {
      game: { pid: 123, exe: "fixture.exe", createdUtc: "fixture" },
      stage: "running",
      skillEditorPhase: "waiting-demo",
    },
    environment = {
      state,
      controlPassword: control.password,
      request: "fixture-stop.request",
      save: async () => {
        environment.saves++;
      },
      f: { exists: async () => environment.stopping },
      w: {
        identity: async () => environment.identity,
        sameProcess: (actual, expected) => actual?.pid === expected.pid,
        ps: async () => environment.owner,
      },
      monitorOwned: () =>
        new Promise((resolve) => {
          exit = resolve;
        }),
      scrubControlSecret: async () => {
        environment.scrubs++;
      },
      setInterval: () => 1,
      clearInterval: () => {
        environment.intervalCleared = true;
      },
      skillEditor: {
        profile: () => "722-v1",
        waitAndLoad: (input) => {
          environment.input = input;
          return new Promise((resolve, reject) => {
            resolveTool = resolve;
            rejectTool = reject;
          });
        },
      },
      stopping: false,
      identity: { pid: 123 },
      owner: "123",
      saves: 0,
      scrubs: 0,
    };
  vm.createContext(environment);
  vm.runInContext(source.slice(start, end), environment);
  const neverExited = new Promise(() => {}),
    running = environment.monitorSkillEditor(control, neverExited);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    state,
    environment,
    running,
    exit: () => exit(),
    reject: (e) => rejectTool(e),
    resolve: () => resolveTool(),
  };
}

test("guardian waits alongside the game, checks TCP ownership and keeps menu alive after tool failure", async () => {
  const h = await workerHarness(),
    e = h.environment;
  assert.equal(e.input.timeoutMs, 30 * 60 * 1000);
  e.owner = "";
  assert.equal(await e.input.isOwned({ connected: false }), true);
  assert.equal(await e.input.isOwned({ connected: true }), false);
  e.owner = "999";
  assert.equal(await e.input.isOwned({ connected: false }), false);
  e.owner = "123";
  assert.equal(await e.input.isOwned({ connected: true }), true);
  e.identity = { pid: 999 };
  assert.equal(await e.input.isOwned({ connected: true }), false);
  e.identity = { pid: 123 };
  await e.input.onPhase("loading");
  assert.equal(h.state.skillEditorPhase, "loading");
  h.reject(Error("fixture rejection " + control.password));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.stage, "running");
  assert.equal(h.state.error, undefined);
  assert.equal(h.state.skillEditorPhase, "error");
  assert.match(h.state.skillEditorError, /fixture rejection/);
  assert.ok(!h.state.skillEditorError.includes(control.password));
  assert.equal(e.intervalCleared, undefined, "game monitor is still running");
  h.exit();
  await h.running;
  assert.equal(e.intervalCleared, true);
  assert.ok(e.scrubs >= 2);
});

test("game exit cancels pending tool work before recovery, and user stop does not report a tool error", async () => {
  const exiting = await workerHarness();
  exiting.exit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await exiting.environment.input.isStopping(), true);
  const phase = exiting.state.skillEditorPhase;
  await exiting.environment.input.onReady();
  assert.equal(exiting.state.skillEditorPhase, phase);
  exiting.reject(Error("fixture cancelled"));
  await exiting.running;
  assert.equal(exiting.state.skillEditorError, undefined);

  const stopping = await workerHarness();
  stopping.environment.stopping = true;
  assert.equal(await stopping.environment.input.isStopping(), true);
  stopping.reject(Error("fixture stopped"));
  stopping.exit();
  await stopping.running;
  assert.equal(stopping.state.skillEditorError, undefined);
});

test("public session data exposes finite editor status but never payload lease or control credentials", async () => {
  const source = await fs.readFile(
      path.join(__dirname, "../src/main.cjs"),
      "utf8",
    ),
    start = source.indexOf("function publicSession("),
    end = source.indexOf("async function launch(", start),
    context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const result = context.publicSession({
    id: "fixture",
    entry: client,
    mode: "skills",
    type: "client",
    stage: "running",
    skillEditorPhase: "waiting-demo",
    skillEditorError: "fixture error",
    skillEditorLease: { files: [{ path: "private-payload" }] },
    skillBootstrap: control,
    controlPassword: control.password,
  });
  assert.equal(result.skillEditorPhase, "waiting-demo");
  assert.equal(result.skillEditorError, "fixture error");
  assert.ok(!JSON.stringify(result).includes(control.password));
  assert.equal(result.skillEditorLease, undefined);
  assert.equal(result.skillBootstrap, undefined);
  assert.equal(result.controlPassword, undefined);
  assert.equal(
    context.publicSession({ entry: client, mode: "menu" }).skillEditorPhase,
    undefined,
  );
});
