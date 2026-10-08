const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const net = require("node:net");
const {
  enabled,
  waitAndLoad,
  _forTesting,
} = require("../src/backend/skill-editor.cjs");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const password = "a1".repeat(32);
const entry = {
  id: "7.22",
  skillEditor: "722-v1",
  source2: true,
  playable: true,
  build: "3504",
};
const status = `Server: Running [127.0.0.1:30325]
Client: Connected [loopback:0] [last packet 0.01 seconds ago]
----- Status -----
@ Current : game
source : slot 0
version : 44
players : 1 humans, 0 bots (0 max) (not hibernating)
loaded spawngroup(1): SV:[1: hero_demo_main |main lump|mapload]
---------players--------
 id time ping loss state rate name
 1 00:00 0 0 active 80000 'synthetic-local-player'
#end
`;

async function filesFixture(t) {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "chronicle-skill-editor-test-"),
  );
  // Recursive test cleanup is limited to the exact freshly-created test directory.
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith("chronicle-skill-editor-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "client"),
    payload = path.join(temp, "payload");
  await fs.mkdir(path.join(root, "game/dota"), { recursive: true });
  const inf = "ClientVersion=3504\nServerVersion=3504\nPatchVersion=7.22\n";
  await fs.writeFile(path.join(root, "game/dota/steam.inf"), inf);
  const files = [];
  for (const target of _forTesting.TARGETS) {
    const source = "original-test-data/" + path.posix.basename(target);
    const bytes = "original synthetic payload: " + source;
    const file = path.join(payload, source);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    files.push({ source, target, sha256: sha(bytes) });
  }
  const manifest = { schema: 1, clientBuild: 3504, files };
  const writeManifest = () =>
    fs.writeFile(path.join(payload, "manifest.json"), JSON.stringify(manifest));
  await writeManifest();
  const state = {
    type: "client",
    host: false,
    mode: "skills",
    root,
    entry: { ...entry, sha: sha(inf) },
  };
  const localization = Buffer.from(
    '"ChronicleSkillLocalization" { "Tokens" {} "SearchTokens" {} }\n',
  );
  const service = _forTesting.createService(payload, async () => localization);
  return {
    temp,
    root,
    payload,
    manifest,
    writeManifest,
    state,
    service,
    target: (index) => path.join(root, manifest.files[index].target),
    bytes: (index) =>
      fs.readFile(path.join(payload, manifest.files[index].source)),
  };
}

async function serverFixture(t, respond = () => status, overrides = {}) {
  const commands = [],
    sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (overrides.greeting) socket.write(overrides.greeting);
    let input = "",
      authenticated = false;
    socket.on("data", (bytes) => {
      input += bytes.toString("utf8");
      for (;;) {
        const index = input.indexOf("\n");
        if (index < 0) break;
        const command = input.slice(0, index).replace(/\r$/, "");
        input = input.slice(index + 1);
        commands.push(command);
        if (command.startsWith("PASS ")) {
          authenticated =
            command === "PASS " + password && overrides.auth !== false;
          socket.write(authenticated ? "Authenticated\n" : "Bad password\n");
          continue;
        }
        if (!authenticated) {
          socket.write("Not authenticated\n");
          continue;
        }
        const response = respond(command, commands, socket);
        if (response !== undefined) socket.write(response);
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
  return { port: server.address().port, commands, sockets };
}
function answer(command) {
  if (command === "status") return status;
  if (command === "script_reload_code chronicle_skill_editor_v1.lua")
    return "CHRONICLE_SKILL_EDITOR_LOADED v1; synthetic\n";
  if (command === "chronicle_skill_panel open")
    return "CHRONICLE_SKILL_EDITOR_PANEL requested; synthetic\nCHRONICLE_SKILL_EDITOR_UI_READY authenticated synthetic panel snapshot\n";
  return "ok\n";
}
function options(fixture, extra = {}) {
  return {
    port: fixture.port,
    password,
    isOwned: async () => true,
    isStopping: async () => false,
    timeoutMs: 3000,
    ...extra,
  };
}
function noBootstrap(commands) {
  assert.ok(!commands.includes("sv_cheats 1"));
}

test("skills mode is a strict canonical 7.22 single-player opt-in", () => {
  const state = { type: "client", host: false, mode: "skills", entry };
  assert.equal(enabled(state), true);
  for (const change of [
    { type: "server" },
    { host: true },
    { host: 0 },
    { host: undefined },
    { mode: "bots" },
    { entry: { ...entry, id: "7.23" } },
    { entry: { ...entry, skillEditor: true } },
    { entry: { ...entry, source2: 1 } },
    { entry: { ...entry, playable: false } },
    { entry: { ...entry, prototype: true } },
    { entry: { ...entry, build: "3505" } },
  ])
    assert.equal(enabled({ ...state, ...change }), false);
});
test("payload roots derive from authoring or unpacked backend location", () => {
  assert.equal(
    _forTesting.payloadDirectory(path.resolve("/app/src/backend")),
    path.resolve("/app/resources/skill-editor/7.22"),
  );
  assert.equal(
    _forTesting.payloadDirectory(path.resolve("/app/app.asar/src/backend")),
    path.resolve("/app/app.asar.unpacked/resources/skill-editor/7.22"),
  );
  assert.equal(
    _forTesting.payloadDirectory(
      path.resolve("/app/app.asar.unpacked/src/backend"),
    ),
    path.resolve("/app/app.asar.unpacked/resources/skill-editor/7.22"),
  );
});
test("prepare persists each ownership intent before exclusive creation; restore deletes only owned unchanged files", async (t) => {
  const f = await filesFixture(t),
    seen = new Set();
  let saves = 0;
  await f.service.prepare(f.state, async () => {
    saves++;
    const row = f.state.skillEditorLease.files.at(-1);
    if (!seen.has(row.path)) {
      seen.add(row.path);
      await assert.rejects(fs.stat(row.path), { code: "ENOENT" });
    }
  });
  assert.ok(saves >= 10);
  assert.equal(f.state.skillEditorLease.files.length, 5);
  for (let index = 0; index < 4; index++)
    assert.equal(
      sha(await fs.readFile(f.target(index))),
      f.manifest.files[index].sha256,
    );
  const unrelated = path.join(
    f.root,
    "game/dota/scripts/vscripts/keep-original.lua",
  );
  await fs.writeFile(unrelated, "original untouched");
  await f.service.restore(f.state);
  assert.equal(f.state.skillEditorLease.restored, true);
  await assert.rejects(fs.stat(f.state.skillEditorLease.files[4].path), {
    code: "ENOENT",
  });
  for (let index = 0; index < 4; index++)
    await assert.rejects(fs.stat(f.target(index)), { code: "ENOENT" });
  assert.equal(await fs.readFile(unrelated, "utf8"), "original untouched");
  assert.ok(
    (await fs.stat(path.dirname(f.target(0)))).isDirectory(),
    "no recursive directory deletion",
  );
  await f.service.restore(f.state);
});
test("preexisting identical payload is unowned and survives restore", async (t) => {
  const f = await filesFixture(t);
  await fs.mkdir(path.dirname(f.target(0)), { recursive: true });
  await fs.writeFile(f.target(0), await f.bytes(0));
  await f.service.prepare(f.state, async () => {});
  assert.equal(f.state.skillEditorLease.files[0].owned, false);
  await f.service.restore(f.state);
  assert.equal(sha(await fs.readFile(f.target(0))), f.manifest.files[0].sha256);
});
test("different preexisting content rejects the whole plan before mutation", async (t) => {
  const f = await filesFixture(t);
  await fs.mkdir(path.dirname(f.target(3)), { recursive: true });
  await fs.writeFile(f.target(3), "user file");
  await assert.rejects(
    f.service.prepare(f.state, async () => {}),
    /已存在不同内容/,
  );
  assert.equal(f.state.skillEditorLease, undefined);
  await assert.rejects(fs.stat(f.target(0)), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.target(3), "utf8"), "user file");
});
test("external changes are preserved and reported while other owned files restore", async (t) => {
  const f = await filesFixture(t);
  await f.service.prepare(f.state, async () => {});
  await fs.writeFile(f.target(1), "external edit");
  await assert.rejects(f.service.restore(f.state), /外部修改/);
  assert.equal(await fs.readFile(f.target(1), "utf8"), "external edit");
  assert.equal(f.state.skillEditorLease.files[1].externalChangePreserved, true);
  assert.equal(f.state.skillEditorLease.restored, true);
  await assert.rejects(fs.stat(f.target(0)), { code: "ENOENT" });
});

test("runtime client-derived name index follows the same recovery lease", async (t) => {
  const f = await filesFixture(t);
  await f.service.prepare(f.state, async () => {});
  const row = f.state.skillEditorLease.files[4];
  assert.match(
    row.path.replaceAll("\\", "/"),
    /\/scripts\/npc\/chronicle_skill_localization_v1\.txt$/,
  );
  await fs.writeFile(row.path, "external name index edit");
  await assert.rejects(f.service.restore(f.state), /外部修改/);
  assert.equal(await fs.readFile(row.path, "utf8"), "external name index edit");
  assert.equal(row.externalChangePreserved, true);
  await assert.rejects(fs.stat(f.target(0)), { code: "ENOENT" });
});

test("name index extraction fails before any client mutation", async (t) => {
  const f = await filesFixture(t);
  const service = _forTesting.createService(f.payload, async () => {
    throw Error("invalid native localization");
  });
  await assert.rejects(
    service.prepare(f.state, async () => {}),
    /invalid native localization/,
  );
  assert.equal(f.state.skillEditorLease, undefined);
  await assert.rejects(fs.stat(f.target(0)), { code: "ENOENT" });
});
test("tampered recovery path fails before deleting any legitimate file", async (t) => {
  const f = await filesFixture(t);
  await f.service.prepare(f.state, async () => {});
  f.state.skillEditorLease.files[3].path = path.join(f.temp, "outside.lua");
  await assert.rejects(f.service.restore(f.state), /租约路径/);
  assert.ok((await fs.stat(f.target(0))).isFile());
});
test("failed pre-save creates no file and its persisted intent can recover safely", async (t) => {
  const f = await filesFixture(t);
  await assert.rejects(
    f.service.prepare(f.state, async () => {
      throw Error("save failed");
    }),
    /save failed/,
  );
  await assert.rejects(fs.stat(f.target(0)), { code: "ENOENT" });
  await f.service.restore(f.state);
  assert.equal(f.state.skillEditorLease.restored, true);
});
for (const mutation of [
  "schema",
  "build",
  "missing",
  "duplicate",
  "target",
  "source",
  "sha",
  "bytes",
]) {
  test(
    "manifest rejects " + mutation + " before touching client",
    async (t) => {
      const f = await filesFixture(t);
      if (mutation === "schema") f.manifest.schema = 2;
      if (mutation === "build") f.manifest.clientBuild = "3504";
      if (mutation === "missing") f.manifest.files.pop();
      if (mutation === "duplicate")
        f.manifest.files[3] = { ...f.manifest.files[0] };
      if (mutation === "target")
        f.manifest.files[0].target =
          "game/dota/scripts/vscripts/addon_game_mode.lua";
      if (mutation === "source")
        f.manifest.files[0].source = "../chronicle_skill_editor_v1.lua";
      if (mutation === "sha") f.manifest.files[0].sha256 = "0".repeat(64);
      if (mutation === "bytes")
        await fs.writeFile(
          path.join(f.payload, f.manifest.files[0].source),
          "tampered",
        );
      await f.writeManifest();
      await assert.rejects(f.service.prepare(f.state, async () => {}));
      assert.equal(f.state.skillEditorLease, undefined);
      await assert.rejects(fs.stat(f.target(0)), { code: "ENOENT" });
    },
  );
}
test("runtime build and bound steam.inf fingerprint are both mandatory", async (t) => {
  const f = await filesFixture(t);
  const wrongBuild = "ClientVersion=3505\n";
  await fs.writeFile(path.join(f.root, "game/dota/steam.inf"), wrongBuild);
  f.state.entry.sha = sha(wrongBuild);
  await assert.rejects(
    f.service.prepare(f.state, async () => {}),
    /ClientVersion/,
  );
  await fs.writeFile(
    path.join(f.root, "game/dota/steam.inf"),
    "ClientVersion=3504\n",
  );
  await assert.rejects(
    f.service.prepare(f.state, async () => {}),
    /指纹/,
  );
});
test("links in payload or recovery target are refused without deleting their destination", async (t) => {
  const f = await filesFixture(t);
  await f.service.prepare(f.state, async () => {});
  const external = path.join(f.temp, "external.lua");
  await fs.writeFile(external, await f.bytes(0));
  await fs.unlink(f.target(0));
  try {
    await fs.symlink(external, f.target(0), "file");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("file links unavailable in this host policy");
      return;
    }
    throw error;
  }
  await assert.rejects(f.service.restore(f.state), /符号链接|目录联接/);
  assert.equal(sha(await fs.readFile(external)), f.manifest.files[0].sha256);
});
test("directory junctions reject preparation and prevent recovery from following a moved target", async (t) => {
  const f = await filesFixture(t);
  const external = path.join(f.temp, "external-vscripts");
  const scriptsParent = path.join(f.root, "game/dota/scripts");
  const vscripts = path.join(scriptsParent, "vscripts");
  await fs.mkdir(external);
  await fs.mkdir(scriptsParent);
  try {
    await fs.symlink(external, vscripts, "junction");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("directory junctions unavailable in host policy");
      return;
    }
    throw error;
  }
  await assert.rejects(
    f.service.prepare(f.state, async () => {}),
    /符号链接|目录联接/,
  );
  assert.equal(f.state.skillEditorLease, undefined);
  await fs.unlink(vscripts);
  await f.service.prepare(f.state, async () => {});
  const originalBytes = await fs.readFile(f.target(3));
  // Both paths remain within the exact test directory before this reversible move.
  const moved = path.join(f.temp, "moved-vscripts");
  assert.ok(path.relative(f.temp, vscripts).startsWith("client" + path.sep));
  assert.equal(path.dirname(moved), f.temp);
  await fs.rename(vscripts, moved);
  await fs.symlink(moved, vscripts, "junction");
  await assert.rejects(f.service.restore(f.state), /符号链接|目录联接/);
  assert.equal(
    sha(await fs.readFile(path.join(moved, "chronicle_skill_editor_v1.lua"))),
    f.manifest.files.find((row) => row.target.endsWith(".lua")).sha256,
  );
  assert.ok(originalBytes.length > 0);
});

test("only complete single local hero demo state is ready", () => {
  for (const loopback of [
    "loopback",
    "loopback:0",
    "loopback:1",
    "loopback:2",
    "loopback:65535",
  ])
    assert.equal(
      _forTesting.parseStatus(status.replace("loopback:0", loopback)).ready,
      true,
    );
  const bad = [
    status.replace("loopback:0", "loopback:65536"),
    status.replace("loopback:0", "loopback:-1"),
    status.replace("loopback:0", "loopback:1.remote"),
    status.replace("#end", ""),
    status.replace("loopback:0", "192.0.2.4:27005"),
    status.replace("1 humans, 0 bots", "2 humans, 0 bots"),
    status.replace("1 humans, 0 bots", "1 humans, 1 bots"),
    status.replace("hero_demo_main", "dota"),
    status.replace("active 80000", "spawning 80000"),
    status.replace(
      " id time ping loss state rate name",
      "player says id time ping loss state rate name",
    ),
    status.replace("#end", " 2 00:00 0 0 active 80000 'synthetic-bot'\n#end"),
    status.replace("#end", "players : 2 humans, 0 bots\n#end"),
    status.replace("#end", "id time ping loss state rate name\n#end"),
  ];
  for (const value of bad)
    assert.equal(_forTesting.parseStatus(value).ready, false);
  assert.throws(() => _forTesting.parseStatus("x".repeat(65537)), /上限/);
  assert.equal(
    _forTesting.parseStatus(
      status.replace(
        "---------players--------",
        "loaded spawngroup(2): CL:[2: dota |view|]\n---------players--------",
      ),
    ).ready,
    true,
    "CL map is never the server map",
  );
  assert.equal(
    _forTesting.parseStatus(
      status.replace(
        "---------players--------",
        "loaded spawngroup(2): SV:[2: hero_demo_main |extra|]\n---------players--------",
      ),
    ).ready,
    true,
    "same server map in several groups remains unambiguous",
  );
  assert.equal(
    _forTesting.parseStatus(
      status.replace(
        "---------players--------",
        "loaded spawngroup(2): SV:[2: dota |extra|]\n---------players--------",
      ),
    ).ready,
    false,
    "contradictory server maps are rejected",
  );
  assert.equal(
    _forTesting.parseStatus(
      status.replace("#end", " 2 BOT 0 0 active 80000 'bot'\n#end"),
    ).ready,
    false,
    "BOT row cannot be treated as a timed human",
  );
  assert.equal(
    _forTesting.parseStatus(status.replace("'synthetic-local-player'", "BOT"))
      .ready,
    false,
    "unquoted fake human row is rejected",
  );
});
test("fixed bootstrap waits for both markers and never emits arbitrary gameplay or Lua", async (t) => {
  const f = await serverFixture(t, answer),
    phases = [],
    connectionFlags = [];
  let ready = 0;
  const result = await waitAndLoad(
    options(f, {
      onPhase: async (value) => phases.push(value),
      onReady: async () => ready++,
      isOwned: async ({ connected }) => {
        connectionFlags.push(connected);
        return true;
      },
    }),
  );
  assert.equal(result.loaded, true);
  assert.equal(result.panelRequested, true);
  assert.equal(result.uiReady, true);
  assert.equal(ready, 1);
  assert.deepEqual(phases, ["waiting-demo", "loading", "ready"]);
  assert.ok(connectionFlags.includes(false) && connectionFlags.includes(true));
  assert.deepEqual(f.commands, [
    "PASS " + password,
    "status",
    "sv_cheats 1",
    "script_reload_code chronicle_skill_editor_v1.lua",
    "chronicle_skill_panel open",
  ]);
});
test("menu polling stays waiting until native demo is ready", async (t) => {
  let polls = 0;
  const f = await serverFixture(t, (command) =>
    command === "status" && ++polls === 1
      ? "Server: Not running\nplayers : 0 humans, 0 bots\n#end\n"
      : answer(command),
  );
  await waitAndLoad(options(f));
  assert.equal(polls, 2);
});
test("cold UI handshake may finish after normal console reply timeout", async (t) => {
  const f = await serverFixture(t, (command, commands, socket) => {
    if (command === "chronicle_skill_panel open") {
      setTimeout(() => {
        if (!socket.destroyed)
          socket.write(
            "CHRONICLE_SKILL_EDITOR_UI_READY authenticated slow native panel\n",
          );
      }, 2300);
      return "CHRONICLE_SKILL_EDITOR_PANEL requested\n";
    }
    return answer(command);
  });
  const result = await waitAndLoad(options(f, { timeoutMs: 6000 }));
  assert.equal(result.uiReady, true);
});
test("disconnected and empty-map dashboard headers remain waiting", async (t) => {
  const menus = [
    "Server: Not running\nClient: Disconnected\n@ Current : menu\nplayers : 0 humans, 0 bots\n#end\n",
    "Server: Not running\nClient: Connected [Not connected]\n@ Current : menu\nplayers : 0 humans, 0 bots\n#end\n",
    status
      .replace("hero_demo_main", "<empty>")
      .replace("active 80000", "active 0"),
    status
      .replace("hero_demo_main", "<empty>")
      .replace("loopback:0", "Not connected")
      .replace("active 80000", "active 0"),
  ];
  for (const menu of menus) {
    const parsed = _forTesting.parseStatus(menu);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.unsafeReason, null);
  }
  let polls = 0;
  const f = await serverFixture(t, (command) =>
    command === "status" && polls < menus.length
      ? menus[polls++]
      : answer(command),
  );
  await waitAndLoad(options(f));
  assert.equal(polls, menus.length);
});
for (const [name, changed] of [
  ["remote player", status.replace("loopback:0", "192.0.2.4:27005")],
  ["multiple humans", status.replace("1 humans, 0 bots", "2 humans, 0 bots")],
  ["bots", status.replace("1 humans, 0 bots", "1 humans, 2 bots")],
  ["ordinary map", status.replace("hero_demo_main", "dota")],
  [
    "extra active row",
    status.replace("#end", " 2 00:00 0 0 active 80000 'bot'\n#end"),
  ],
])
  test("rejects " + name + " before any bootstrap", async (t) => {
    const f = await serverFixture(t, (command) =>
      command === "status" ? changed : answer(command),
    );
    await assert.rejects(waitAndLoad(options(f)), /未加载/);
    noBootstrap(f.commands);
  });
for (const response of [
  "Unknown command: script_reload_code\n",
  "Script Runtime Error\n",
  "scripts/vscripts/chronicle_skill_editor_v1.lua:45: attempt to call nil\n",
  "CHRONICLE_SKILL_REFUSED wrong context\n",
]) {
  test(
    "native unknown/Lua/refusal never reports ready: " + response.trim(),
    async (t) => {
      const f = await serverFixture(t, (command) =>
        command.startsWith("script_reload_code") ? response : answer(command),
      );
      let ready = false;
      await assert.rejects(
        waitAndLoad(
          options(f, {
            onReady: async () => {
              ready = true;
            },
          }),
        ),
        /拒绝|Lua/,
      );
      assert.equal(ready, false);
      assert.ok(!f.commands.includes("chronicle_skill_panel open"));
    },
  );
}
test("authentication failure and oversized reply fail closed", async (t) => {
  const auth = await serverFixture(t, answer, { auth: false });
  await assert.rejects(waitAndLoad(options(auth)), /认证失败/);
  noBootstrap(auth.commands);
  const huge = await serverFixture(t, (command) =>
    command === "status" ? "x".repeat(65537) : answer(command),
  );
  await assert.rejects(waitAndLoad(options(huge)), /安全上限/);
  noBootstrap(huge.commands);
});
test("missing success marker cannot produce ready", async (t) => {
  const f = await serverFixture(t, (command) =>
    command === "chronicle_skill_panel open" ? "ok\n" : answer(command),
  );
  let ready = false;
  await assert.rejects(
    waitAndLoad(
      options(f, {
        timeoutMs: 1200,
        onReady: async () => {
          ready = true;
        },
      }),
    ),
    /超时|标记/,
  );
  assert.equal(ready, false);
});
test("panel creation alone is not UI readiness", async (t) => {
  const f = await serverFixture(t, (command) =>
    command === "chronicle_skill_panel open"
      ? "CHRONICLE_SKILL_EDITOR_PANEL requested\n"
      : answer(command),
  );
  let ready = false;
  await assert.rejects(
    waitAndLoad(
      options(f, {
        timeoutMs: 1000,
        onReady: async () => {
          ready = true;
        },
      }),
    ),
    /超时|标记/,
  );
  assert.equal(ready, false);
});
test("native VScript-prefixed module and authenticated UI acknowledgements are accepted", async (t) => {
  const f = await serverFixture(t, (command) => {
    if (command.startsWith("script_reload_code"))
      return "[VScript] CHRONICLE_SKILL_EDITOR_LOADED v1\n";
    if (command === "chronicle_skill_panel open")
      return "[VScript] CHRONICLE_SKILL_EDITOR_PANEL requested\n[VScript] CHRONICLE_SKILL_EDITOR_UI_READY authenticated snapshot\n";
    return answer(command);
  });
  assert.equal((await waitAndLoad(options(f))).uiReady, true);
});
test("bounded ring tolerates native cold-load bursts and retains evicted success markers", async (t) => {
  const burst = (
    "native synthetic map-loading line " +
    "x".repeat(190) +
    "\n"
  ).repeat(1200);
  let polls = 0;
  const f = await serverFixture(
    t,
    (command) => {
      if (command === "status" && ++polls === 1)
        return status.replace("hero_demo_main", "<empty>") + burst;
      if (command.startsWith("script_reload_code"))
        return answer(command) + burst;
      if (command === "chronicle_skill_panel open")
        return answer(command) + burst;
      return answer(command);
    },
    { greeting: burst },
  );
  const result = await waitAndLoad(options(f, { timeoutMs: 5000 }));
  assert.equal(result.uiReady, true);
  assert.ok(
    polls >= 2,
    "an evicted/incomplete status snapshot is retried rather than accepted",
  );
});
test("authentication and Lua errors cannot be evicted by later burst output", async (t) => {
  const burst = ("native synthetic short log " + "x".repeat(100) + "\n").repeat(
    1300,
  );
  for (const earlyError of [
    "[VScript] CHRONICLE_SKILL_REFUSED failed\n",
    "Bad password\n",
  ]) {
    const f = await serverFixture(t, (command) =>
      command.startsWith("script_reload_code")
        ? earlyError + burst + answer(command)
        : answer(command),
    );
    await assert.rejects(waitAndLoad(options(f)), /拒绝|认证失败/);
    assert.ok(!f.commands.includes("chronicle_skill_panel open"));
  }
});
test("ownership loss after connect refuses authentication and bootstrap", async (t) => {
  const f = await serverFixture(t, answer);
  await assert.rejects(
    waitAndLoad(options(f, { isOwned: async ({ connected }) => !connected })),
    /不再属于/,
  );
  assert.deepEqual(f.commands, []);
});
test("stop cancels an outstanding status reply quickly", async (t) => {
  let stopping = false;
  const f = await serverFixture(t, (command) => {
    if (command === "status") {
      stopping = true;
      return undefined;
    }
    return answer(command);
  });
  const started = Date.now();
  await assert.rejects(
    waitAndLoad(options(f, { isStopping: async () => stopping })),
    { code: "SKILL_EDITOR_CANCELLED" },
  );
  assert.ok(Date.now() - started < 1000);
  noBootstrap(f.commands);
});
test("stop cancels even when ownership check hangs", async (t) => {
  const f = await serverFixture(t, answer);
  let stopping = false;
  const timer = setTimeout(() => {
    stopping = true;
  }, 80);
  t.after(() => clearTimeout(timer));
  await assert.rejects(
    waitAndLoad(
      options(f, {
        isOwned: () => new Promise(() => {}),
        isStopping: () => stopping,
      }),
    ),
    { code: "SKILL_EDITOR_CANCELLED" },
  );
  assert.deepEqual(f.commands, []);
});
test("closed authenticated socket is not retried", async (t) => {
  const f = await serverFixture(t, (command, _, socket) => {
    if (command === "status") {
      socket.destroy();
      return undefined;
    }
    return answer(command);
  });
  await assert.rejects(waitAndLoad(options(f)), /关闭|错误/);
  assert.equal(
    f.commands.filter((command) => command.startsWith("PASS ")).length,
    1,
  );
  noBootstrap(f.commands);
});
test("untrusted control parameters are rejected before connection", async () => {
  for (const changed of [
    { port: 80 },
    { password: "guessable" },
    { timeoutMs: 1800001 },
    { isOwned: true },
    { onReady: true },
    { continuous: 1 },
  ]) {
    await assert.rejects(
      waitAndLoad({
        port: 12345,
        password,
        isOwned: () => true,
        isStopping: () => false,
        ...changed,
      }),
      /参数无效/,
    );
  }
});
test("continuous mode reloads on a confirmed map transition but leaves a user-closed panel alone", async (t) => {
  let polls = 0,
    ready = 0,
    stopping = false;
  const phases = [];
  const f = await serverFixture(t, (command) => {
    if (command === "status") {
      polls++;
      if (polls === 2)
        return (
          "CHRONICLE_SKILL_REFUSED synthetic advanced item rejected\n" + status
        );
      if (polls === 3) return status.replace("hero_demo_main", "<empty>");
      return status;
    }
    if (command.startsWith("script_reload_code") && ready > 0)
      return "CHRONICLE_SKILL_REUSE retained ownership\nCHRONICLE_SKILL_EDITOR_LOADED v1 reused\n";
    return answer(command);
  });
  await assert.rejects(
    waitAndLoad(
      options(f, {
        continuous: true,
        sleep: (ms) =>
          new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))),
        onPhase: (value) => {
          phases.push(value);
        },
        onReady: () => {
          ready++;
          if (ready === 2) stopping = true;
        },
        isStopping: () => stopping,
      }),
    ),
    { code: "SKILL_EDITOR_CANCELLED" },
  );
  assert.equal(ready, 2);
  assert.deepEqual(phases, [
    "waiting-demo",
    "loading",
    "ready",
    "waiting-demo",
    "loading",
    "ready",
  ]);
  assert.equal(
    f.commands.filter((command) => command === "chronicle_skill_panel open")
      .length,
    2,
    "a same-map status does not reopen a panel closed by the user",
  );
  assert.equal(
    f.commands.filter((command) => command.startsWith("script_reload_code"))
      .length,
    2,
  );
});
test("continuous active practice time does not consume the waiting deadline", async (t) => {
  let stopping = false,
    ready = 0;
  const f = await serverFixture(t, answer);
  const timer = setTimeout(() => {
    stopping = true;
  }, 1400);
  t.after(() => clearTimeout(timer));
  await assert.rejects(
    waitAndLoad(
      options(f, {
        continuous: true,
        timeoutMs: 700,
        isStopping: () => stopping,
        onReady: () => {
          ready++;
        },
      }),
    ),
    { code: "SKILL_EDITOR_CANCELLED" },
  );
  assert.equal(ready, 1);
  assert.equal(
    f.commands.filter((command) => command === "chronicle_skill_panel open")
      .length,
    1,
  );
});
test("incomplete status is not a map-transition signal", async (t) => {
  let polls = 0,
    ready = 0,
    stopping = false;
  const f = await serverFixture(t, (command) => {
    if (command === "status" && ++polls === 2)
      return "players : 1 humans, 0 bots\n";
    if (command === "status" && polls >= 3) stopping = true;
    return answer(command);
  });
  await assert.rejects(
    waitAndLoad(
      options(f, {
        continuous: true,
        sleep: (ms) =>
          new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))),
        onReady: () => {
          ready++;
        },
        isStopping: () => stopping,
      }),
    ),
    { code: "SKILL_EDITOR_CANCELLED" },
  );
  assert.equal(ready, 1);
  assert.equal(
    f.commands.filter((command) => command.startsWith("script_reload_code"))
      .length,
    1,
  );
});
