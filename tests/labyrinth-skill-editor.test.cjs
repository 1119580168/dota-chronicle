const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const net = require("node:net");
const catalog = require("../resources/catalog.json");
const events = require("../src/backend/event-catalog.cjs");
const plans = require("../src/backend/plans.cjs");
const editor = require("../src/backend/skill-editor.cjs");
const client = catalog.entries.find((entry) => entry.id === "7.27c");
const event = client.events.find((entry) => entry.id === "aghanim1");
const mode = "aghanim1-skills";
const profile = "727c-aghanim-v1";
const password = "a1".repeat(32);
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const status = `Server: Running [127.0.0.1:27491]
Client: Connected [loopback:0] [last packet 0.01 seconds ago]
@ Current : game
players : 1 humans, 0 bots (0 max) (not hibernating)
loaded spawngroup(1): SV:[1: main |main lump|mapload]
 id time ping loss state rate name
 1 00:00 0 0 active 80000 'synthetic-local-player'
#end
`;

test("Labyrinth editor permission requires the exact client, official event, and single-player route", () => {
  assert.equal(events.skillEditorProfile(client, mode), profile);
  assert.equal(events.skillEditorProfile(client, "aghanim1"), null);
  assert.equal(
    editor.enabled({ entry: client, mode, type: "client", host: false }),
    true,
  );
  for (const changes of [
    { id: "7.30e" },
    { build: "4398" },
    { source2: false },
    { playable: false },
    { prototype: true },
    { events: [] },
  ]) {
    const invalid = { ...client, ...changes };
    assert.equal(events.skillEditorProfile(invalid, mode), null);
    assert.throws(() => events.assertSkillEditorMode(invalid, mode));
  }
  for (const changes of [
    { id: "dota-mijing" },
    { version: "7.22" },
    { addon: "aghanim2" },
    { map: "dota" },
    { category: "community" },
    { skillEditor: undefined },
    { skillEditor: "722-v1" },
    { launchDisabledReason: "disabled fixture" },
  ]) {
    const invalidEvent = { ...event, ...changes };
    const invalid = { ...client, events: [invalidEvent] };
    assert.equal(events.skillEditorProfile(invalid, mode), null);
    assert.throws(() => events.assertSkillEditorMode(invalid, mode));
    if (invalidEvent.skillEditor !== undefined)
      assert.throws(() => events.validateEventCatalog({ entries: [invalid] }));
  }
  for (const options of [
    { host: true },
    { type: "dedicated" },
    { type: "unknown" },
  ])
    assert.throws(() =>
      events.trustedEntryForSession(catalog, {
        entry: client,
        mode,
        ...options,
      }),
    );
  assert.throws(() =>
    events.trustedEntryForSession(catalog, {
      entry: client,
      mode: "join",
      joinMode: mode,
    }),
  );
  assert.equal(
    events.trustedEntryForSession(catalog, { entry: { id: "7.27c" }, mode }),
    client,
  );
});

test("Labyrinth skills uses its original official map with loopback cheats and authenticated control", () => {
  const runtime = {
    root: path.resolve("unlaunchable-labyrinth-fixture"),
    event,
  };
  const options = {
    room: plans.roomOptions(),
    cfgName: "fixture.cfg",
    log: "fixture.log",
    packages: {},
    skillBootstrap: { port: 50423, password },
  };
  const args = plans.buildArgs(client, mode, runtime, options);
  assert.equal(args[args.indexOf("-ip") + 1], "127.0.0.1");
  assert.equal(args[args.indexOf("-netconpassword") + 1], password);
  assert.equal(args.filter((arg) => arg === "-netconport").length, 1);
  assert.equal(
    args.includes("+dota_launch_custom_game"),
    false,
    "official addon launch waits for a stable dashboard instead of racing its layouts",
  );
  const ordinary = plans.buildArgs(client, "aghanim1", runtime, {
    ...options,
    skillBootstrap: undefined,
  });
  assert.deepEqual(
    ordinary.slice(ordinary.indexOf("+dota_launch_custom_game")),
    ["+dota_launch_custom_game", "aghanim", "main"],
  );
  assert.equal(args.includes("-addon_path"), false);
  assert.equal(args.includes("+map"), false);
  assert.match(
    plans.buildClientCfg({ entry: client, mode, event, host: false }),
    /^sv_cheats 1$/m,
  );
  assert.doesNotMatch(
    plans.buildClientCfg({ entry: client, mode: "aghanim1", event }),
    /^sv_cheats 1$/m,
  );
  assert.throws(() =>
    plans.buildArgs(client, mode, runtime, { ...options, host: true }),
  );
  assert.throws(() =>
    plans.buildArgs(client, mode, runtime, {
      ...options,
      skillBootstrap: undefined,
    }),
  );
  assert.throws(() => plans.buildArgs(client, "aghanim1", runtime, options));
  assert.throws(() =>
    plans.buildArgs(
      client,
      mode,
      { ...runtime, event: client.events[1] },
      options,
    ),
  );
  assert.throws(() =>
    plans.buildClientCfg({ entry: client, mode, event: undefined }),
  );
});

async function filesFixture(t) {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "chronicle-labyrinth-test-"),
  );
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith("chronicle-labyrinth-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "client"),
    payload = path.join(temp, "payload");
  await fs.mkdir(path.join(root, "game/dota"), { recursive: true });
  const inf = "ClientVersion=4397\nServerVersion=4397\n";
  await fs.writeFile(path.join(root, "game/dota/steam.inf"), inf);
  const files = [];
  for (const target of editor._forTesting.LABYRINTH_TARGETS) {
    const source = "synthetic/" + path.posix.basename(target);
    const bytes = Buffer.from("synthetic original tool " + source);
    await fs.mkdir(path.dirname(path.join(payload, source)), {
      recursive: true,
    });
    await fs.writeFile(path.join(payload, source), bytes);
    files.push({ source, target, sha256: digest(bytes) });
  }
  const manifest = { schema: 1, clientBuild: 4397, profile, files };
  const saveManifest = () =>
    fs.writeFile(path.join(payload, "manifest.json"), JSON.stringify(manifest));
  await saveManifest();
  const state = {
    entry: { ...client, sha: digest(inf) },
    root,
    mode,
    type: "client",
    host: false,
  };
  const service = editor._forTesting.createService(payload, async () =>
    Buffer.from('"ChronicleSkillLocalization" { "Tokens" {} }'),
  );
  return { root, state, service, manifest, saveManifest };
}

test("Labyrinth tool lease installs only separate owned files and preserves addon originals and 7.22 tools", async (t) => {
  const f = await filesFixture(t);
  const addon = path.join(
    f.root,
    "game/dota_addons/aghanim/scripts/vscripts/addon_game_mode.lua",
  );
  const oldTool = path.join(f.root, editor._forTesting.TARGETS[0]);
  await fs.mkdir(path.dirname(addon), { recursive: true });
  await fs.mkdir(path.dirname(oldTool), { recursive: true });
  await fs.writeFile(addon, "original synthetic addon initialization");
  await fs.writeFile(oldTool, "existing 7.22 tool");
  const originals = [
    await fs.readFile(addon, "utf8"),
    await fs.readFile(oldTool, "utf8"),
  ];
  await f.service.prepare(f.state, async () => {});
  assert.equal(f.state.skillEditorLease.clientBuild, 4397);
  assert.equal(f.state.skillEditorLease.profile, profile);
  assert.equal(f.state.skillEditorLease.files.length, 5);
  await f.service.restore(f.state);
  assert.equal(f.state.skillEditorLease.restored, true);
  assert.deepEqual(
    [await fs.readFile(addon, "utf8"), await fs.readFile(oldTool, "utf8")],
    originals,
  );
  for (const row of f.state.skillEditorLease.files)
    await assert.rejects(fs.stat(row.path), { code: "ENOENT" });
});

test("wrong profile, build, cross-profile target, or client fingerprint fails before installation", async (t) => {
  for (const mutate of [
    (f) => {
      f.manifest.profile = "722-v1";
    },
    (f) => {
      f.manifest.clientBuild = 3504;
    },
    (f) => {
      f.manifest.files[0].target = editor._forTesting.TARGETS[0];
    },
    (f) => {
      f.state.entry.sha = "f".repeat(64);
    },
  ]) {
    const f = await filesFixture(t);
    mutate(f);
    await f.saveManifest();
    await assert.rejects(f.service.prepare(f.state, async () => {}));
    assert.equal(f.state.skillEditorLease, undefined);
    await assert.rejects(
      fs.stat(path.join(f.root, editor._forTesting.LABYRINTH_TARGETS[0])),
      { code: "ENOENT" },
    );
  }
});

test("recovery cannot delete a target from the other profile and preserves external edits", async (t) => {
  const f = await filesFixture(t);
  await f.service.prepare(f.state, async () => {});
  const row = f.state.skillEditorLease.files[0],
    originalPath = row.path;
  row.path = path.join(f.root, editor._forTesting.TARGETS[0]);
  await assert.rejects(f.service.restore(f.state), /租约路径/);
  assert.ok((await fs.stat(originalPath)).isFile());
  row.path = originalPath;
  await fs.writeFile(originalPath, "external edit preserved");
  await assert.rejects(f.service.restore(f.state), /外部修改/);
  assert.equal(
    await fs.readFile(originalPath, "utf8"),
    "external edit preserved",
  );
  assert.equal(f.state.skillEditorLease.restored, true);
});

test("native status remains confined to one active local player and the expected map", () => {
  assert.equal(editor._forTesting.parseStatus(status, profile).ready, true);
  assert.equal(editor._forTesting.parseStatus(status).ready, false);
  for (const text of [
    status.replace("main |", "dota |"),
    status.replace("loopback:0", "192.0.2.3:27005"),
    status.replace("1 humans, 0 bots", "2 humans, 0 bots"),
    status.replace("1 humans, 0 bots", "1 humans, 1 bots"),
    status.replace("active 80000", "spawning 80000"),
    status.replace("#end", ""),
  ])
    assert.equal(editor._forTesting.parseStatus(text, profile).ready, false);
  assert.throws(() =>
    editor._forTesting.parseStatus(status, "unregistered-profile"),
  );
});

test("Labyrinth combat room subgroups retain the unique main root without relaxing 7.22", () => {
  const rooms = status.replace(
    " id time",
    "loaded spawngroup(5): SV:[5: radiant_forest |room|]\nloaded spawngroup(6): SV:[6: radiant_ring |room|]\n id time",
  );
  assert.equal(editor._forTesting.parseStatus(rooms, profile).ready, true);
  assert.equal(editor._forTesting.parseStatus(rooms, profile).map, "main");
  assert.equal(
    editor._forTesting.parseStatus(rooms, profile).outsideDemo,
    false,
  );
  assert.equal(
    editor._forTesting.parseStatus(rooms.replace("main |", "hero_demo_main |"))
      .ready,
    false,
  );
  for (const invalid of [
    rooms.replace(/^loaded spawngroup\(1\).*\n/m, ""),
    rooms.replace("SV:[1: main", "SV:[2: main"),
    rooms.replace("spawngroup(1)", "spawngroup(2)"),
    rooms.replace(
      " id time",
      "loaded spawngroup(1): SV:[1: main |duplicate|]\n id time",
    ),
    rooms.replace("main |", "dota |"),
  ])
    assert.equal(editor._forTesting.parseStatus(invalid, profile).ready, false);
});

async function serverFixture(t, respond) {
  const commands = [],
    sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let pending = "",
      authenticated = false;
    socket.on("data", (bytes) => {
      pending += bytes.toString("utf8");
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        const command = pending.slice(0, index).replace(/\r$/, "");
        pending = pending.slice(index + 1);
        commands.push(command);
        if (command.startsWith("PASS ")) {
          authenticated = command === "PASS " + password;
          socket.write(authenticated ? "Authenticated\n" : "Bad password\n");
        } else if (!authenticated) socket.write("Not authenticated\n");
        else socket.write(respond(command) || "ok\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, commands };
}

test("loader waits for assigned hero then the profile's authenticated panel handshake", async (t) => {
  let contextQueries = 0;
  const f = await serverFixture(t, (command) => {
    if (command === "status") return status;
    if (command === editor._forTesting.LABYRINTH_CONTEXT_COMMAND)
      return ++contextQueries === 1
        ? "CHRONICLE_LABYRINTH_SKILL_CONTEXT_WAIT\n"
        : "CHRONICLE_LABYRINTH_SKILL_CONTEXT_READY\n";
    if (
      command === "script_reload_code chronicle_labyrinth_skill_editor_v1.lua"
    )
      return "CHRONICLE_LABYRINTH_SKILL_EDITOR_LOADED v1\n";
    if (command === "chronicle_labyrinth_skill_panel open")
      return "CHRONICLE_LABYRINTH_SKILL_EDITOR_UI_READY authenticated synthetic snapshot\n";
    return "ok\n";
  });
  const phases = [];
  const result = await editor.waitAndLoad({
    profile,
    port: f.port,
    password,
    isOwned: async () => true,
    isStopping: async () => false,
    timeoutMs: 4000,
    onPhase: async (phase) => phases.push(phase),
  });
  assert.equal(result.uiReady, true);
  assert.equal(result.map, "main");
  assert.equal(contextQueries, 2);
  assert.deepEqual(phases, [
    "waiting-labyrinth",
    "loading",
    "waiting-labyrinth",
    "loading",
    "ready",
  ]);
  assert.equal(
    f.commands.filter((command) => command.startsWith("script_reload_code "))
      .length,
    1,
  );
  assert.ok(!f.commands.includes("chronicle_skill_panel open"));
  assert.ok(
    !f.commands.some((command) =>
      command.includes("chronicle_skill_editor_v1.lua"),
    ),
  );
});

test("Labyrinth refusal or a 7.22 handshake never reports panel ready", async (t) => {
  for (const refusal of [
    "CHRONICLE_LABYRINTH_SKILL_REFUSED wrong context\n",
    "CHRONICLE_SKILL_EDITOR_UI_READY wrong profile\n",
  ]) {
    const f = await serverFixture(t, (command) => {
      if (command === "status") return status;
      if (command === editor._forTesting.LABYRINTH_CONTEXT_COMMAND)
        return "CHRONICLE_LABYRINTH_SKILL_CONTEXT_READY\n";
      if (command.startsWith("script_reload_code"))
        return "CHRONICLE_LABYRINTH_SKILL_EDITOR_LOADED v1\n";
      if (command === "chronicle_labyrinth_skill_panel open") return refusal;
    });
    let ready = false;
    await assert.rejects(
      editor.waitAndLoad({
        profile,
        port: f.port,
        password,
        isOwned: async () => true,
        isStopping: async () => false,
        timeoutMs: 850,
        onReady: async () => {
          ready = true;
        },
      }),
    );
    assert.equal(ready, false);
  }
});

test("cold startup launches the fixed official addon once after a stable local dashboard", async (t) => {
  let launched = false;
  const dashboard = status.replace("main |", "<empty> |");
  const f = await serverFixture(t, (command) => {
    if (command === "status") return launched ? status : dashboard;
    if (command === "dota_launch_custom_game aghanim main") {
      launched = true;
      return "Loading synthetic addon\n";
    }
    if (command === editor._forTesting.LABYRINTH_CONTEXT_COMMAND)
      return "CHRONICLE_LABYRINTH_SKILL_CONTEXT_READY\n";
    if (command.startsWith("script_reload_code"))
      return "CHRONICLE_LABYRINTH_SKILL_EDITOR_LOADED v1\n";
    if (command === "chronicle_labyrinth_skill_panel open")
      return "CHRONICLE_LABYRINTH_SKILL_EDITOR_UI_READY authenticated synthetic snapshot\n";
  });
  const started = Date.now();
  const result = await editor.waitAndLoad({
    profile,
    port: f.port,
    password,
    isOwned: async () => true,
    isStopping: async () => false,
    timeoutMs: 7000,
  });
  assert.equal(result.uiReady, true);
  assert.ok(Date.now() - started >= 3000);
  assert.equal(
    f.commands.filter(
      (command) => command === "dota_launch_custom_game aghanim main",
    ).length,
    1,
  );
  const launchIndex = f.commands.indexOf(
    "dota_launch_custom_game aghanim main",
  );
  assert.ok(
    f.commands.slice(0, launchIndex).filter((command) => command === "status")
      .length >= 3,
  );
  assert.ok(
    !f.commands
      .slice(0, launchIndex)
      .some(
        (command) =>
          command.startsWith("script ") ||
          command.startsWith("script_reload_code "),
      ),
  );
});
