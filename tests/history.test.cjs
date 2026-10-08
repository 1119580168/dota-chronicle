const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { hydrateHistory } = require("../src/backend/history.cjs");
const { extractPatch } = require("../scripts/build-history.cjs");
const { MediaLibrary } = require("../src/backend/media.cjs");
const { Library } = require("../src/backend/library.cjs");
const { inspect } = require("../src/backend/plans.cjs");
const plans = require("../src/backend/plans.cjs");
const { skillEditorProfile } = require("../src/backend/event-catalog.cjs");
const { hash, writeJson } = require("../src/backend/files.cjs");
const { compareHistory } = require("../src/backend/chronology.cjs");
const { orderClients } = require("../src/backend/history.cjs");
const catalog = require("../resources/catalog.json"),
  history = require("../resources/history.json");
test("history keeps every official modern patch and only exact runtime associations", () => {
  assert.ok(history.entries.length > 700);
  const numbered = history.entries.filter((h) => h.kind === "patch");
  assert.equal(new Set(numbered.map((h) => h.version)).size, numbered.length);
  assert.ok(numbered.find((h) => h.version === "7.41f"));
  assert.equal(numbered.find((h) => h.version === "7.00").runtimeId, "7.00");
  assert.equal(catalog.entries.find((e) => e.id === "7.00").build, "1810");
  const hydrated = hydrateHistory(
    history,
    catalog.entries.map((e) => ({ ...e, installed: e.id === "7.37e" })),
  );
  assert.equal(hydrated.entries.filter((h) => h.owned).length, 1);
  const snapshot = hydrated.entries.find((h) => h.version === "7.37e");
  assert.equal(snapshot.date.slice(0, 4), "2024");
  assert.equal(snapshot.snapshotYear, 2025);
  assert.equal(
    extractPatch({
      title: "Dota 2 Update",
      contents: "Updated bot builds for 7.00.",
    }),
    undefined,
  );
  assert.equal(
    extractPatch({
      title: "Dota 2 Update",
      contents: "7.01<br>====<br>Balance changes",
    }),
    "7.01",
  );
});
test("chronology uses client release dates, keeps build dates separate and never invents January dates", () => {
  assert.deepEqual(history.entries, [...history.entries].sort(compareHistory));
  const patch = (v) => history.entries.find((h) => h.id === "patch-" + v);
  assert.equal(patch("6.73").date, "2012-01-12");
  assert.equal(patch("6.81").date, "2014-04-29");
  assert.equal(patch("6.81").announcementDate, "2014-04-26");
  assert.equal(patch("6.83").date, "2014-12-17");
  assert.equal(patch("6.85b").date, "2015-11-01");
  assert.equal(patch("6.85b").announcementDate, "2015-10-29");
  assert.ok(
    history.entries.indexOf(patch("6.81")) <
      history.entries.indexOf(patch("6.83")),
  );
  assert.ok(
    history.entries.indexOf(patch("6.84")) <
      history.entries.indexOf(patch("6.84b")),
  );
  const build = history.entries.find(
    (h) => h.runtimeId === "build2311-20170716",
  );
  assert.equal(build.date, "2017-07-16");
  assert.equal(build.dateType, "build");
  assert.ok(
    history.entries.indexOf(patch("7.03")) < history.entries.indexOf(build),
  );
  assert.ok(
    history.entries.indexOf(build) < history.entries.indexOf(patch("7.07")),
  );
  const dates = [
    { id: "unknown", year: 2014, date: null, version: "6.83" },
    { id: "known", year: 2014, date: "2014-09-25", version: "6.82" },
  ];
  assert.equal([...dates].sort(compareHistory)[0].id, "known");
  assert.equal(dates[0].date, null);
  const ordered = orderClients(history, [...catalog.entries].reverse());
  assert.deepEqual(
    ordered.map((e) => e.id),
    catalog.entries.map((e) => e.id),
  );
  const modern = ordered.find((e) => e.id === "7.37e");
  assert.equal(modern.updateYear, 2024);
  assert.equal(modern.snapshotDate, "2025-02-06");
});

test("7.35d links only its exact patch while retaining April build chronology and isolated capabilities", () => {
  const client = catalog.entries.find((e) => e.id === "7.35d");
  const patch = history.entries.find((e) => e.id === "patch-7.35d");
  assert.equal(patch.runtimeId, client.id);
  assert.equal(patch.date, "2024-03-21");
  assert.equal(client.snapshotDate, "2024-04-29");
  assert.equal(client.build, "6040");
  assert.deepEqual(client.events, []);
  assert.equal(skillEditorProfile(client, "skills"), null);
  assert.equal(skillEditorProfile(client, "aghanim1-skills"), null);
  const hydrated = hydrateHistory(
    history,
    catalog.entries.map((e) => ({
      ...e,
      installed: e.id === client.id,
    })),
  );
  const row = hydrated.entries.find((e) => e.id === patch.id);
  assert.equal(row.localAvailable, true);
  assert.equal(row.availability, "local");
  assert.equal(row.snapshotDate, "2024-04-29");
  assert.equal(hydrated.entries.filter((e) => e.localAvailable).length, 1);
  const ordered = orderClients(history, [...catalog.entries].reverse());
  assert.ok(
    ordered.findIndex((e) => e.id === "7.32") <
      ordered.findIndex((e) => e.id === client.id),
  );
  assert.ok(
    ordered.findIndex((e) => e.id === client.id) <
      ordered.findIndex((e) => e.id === "7.37e"),
  );
  assert.equal(
    ordered.find((e) => e.id === client.id).updateDate,
    "2024-03-21",
  );
});

test("7.35d normal menu, practice and listen-room plans do not inherit unvalidated addons or editing", () => {
  const client = catalog.entries.find((e) => e.id === "7.35d"),
    runtime = { root: path.resolve("unlaunchable-735d-fixture") },
    options = {
      room: plans.roomOptions(),
      cfgName: "fixture.cfg",
      log: "fixture.log",
      packages: {},
      language: "schinese",
    };
  const menu = plans.buildArgs(client, "menu", runtime, options);
  const practice = plans.buildArgs(client, "bots", runtime, options);
  const room = plans.buildArgs(client, "bots", runtime, {
    ...options,
    host: true,
  });
  const join = plans.buildArgs(client, "join", runtime, {
    ...options,
    join: "192.0.2.5",
  });
  assert.equal(menu.includes("+map"), false);
  assert.equal(practice[practice.indexOf("+map") + 1], "dota");
  assert.equal(practice[practice.indexOf("-ip") + 1], "127.0.0.1");
  assert.equal(practice[practice.indexOf("+dota_bot_practice_start") + 1], "1");
  assert.equal(room[room.indexOf("-ip") + 1], "0.0.0.0");
  assert.equal(room[room.indexOf("+map") + 1], "dota");
  assert.equal(room.includes("+dota_bot_practice_start"), false);
  assert.equal(room[room.indexOf("+sv_password") + 1], options.room.password);
  assert.equal(
    join[join.indexOf("+connect") + 1],
    "192.0.2.5:" + options.room.port,
  );
  assert.equal(join.includes("+map"), false);
  for (const args of [menu, practice, room, join]) {
    assert.equal(args[args.indexOf("-language") + 1], "schinese");
    assert.equal(args.filter((arg) => arg === "-console").length, 1);
    assert.equal(args.includes("-netconport"), false);
    assert.equal(args.includes("+dota_launch_custom_game"), false);
    assert.equal(args.includes("-addon_path"), false);
  }
  assert.throws(() => plans.buildArgs(client, "skills", runtime, options));
  assert.throws(() =>
    plans.buildArgs(client, "aghanim1-skills", runtime, options),
  );
});

test("7.35d binding and refresh require a matching real Source 2 installation and fingerprint", async (t) => {
  const data = await fs.mkdtemp(
    path.join(os.tmpdir(), "chronicle-735d-binding-"),
  );
  assert.equal(path.dirname(data), path.resolve(os.tmpdir()));
  assert.ok(path.basename(data).startsWith("chronicle-735d-binding-"));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const root = path.join(data, "client"),
    entry = catalog.entries.find((e) => e.id === "7.35d");
  await fs.mkdir(path.join(root, "game/dota"), { recursive: true });
  await fs.mkdir(path.join(root, "game/bin/win64"), { recursive: true });
  await fs.writeFile(
    path.join(root, entry.exe),
    "synthetic non-executable client fixture",
  );
  const infFile = path.join(root, entry.steamInf);
  await fs.writeFile(
    infFile,
    "synthetic 7.35d metadata, not the archived client",
  );
  await assert.rejects(inspect(entry, root, "menu"), /构建/);
  const fixture = { ...entry, sha: await hash(infFile) };
  const lib = await new Library({ entries: [fixture] }, data).load();
  await lib.bind(entry.id, root);
  assert.equal((await lib.snapshot()).entries[0].installed, true);
  for (const mode of ["menu", "bots", "join"])
    assert.equal((await inspect(fixture, root, mode)).event, undefined);
  await assert.rejects(inspect(fixture, root, "wikibox-old"), /地图不属于/);
  await fs.writeFile(infFile, "different client fingerprint");
  assert.equal((await lib.snapshot()).entries[0].installed, false);
});
test("unbound clients get no media; incomplete owned archives allow only validated menus", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-history-"));
  try {
    const m = await new MediaLibrary(data, catalog).load();
    let reads = [];
    m.forTarget = async (id) => {
      reads.push(id);
      return { cover: { id }, shots: {}, videos: [] };
    };
    const snapshot = {
      entries: [
        { id: "unowned", installed: false, events: [{ id: "event" }] },
        { id: "archive", archived: true, events: [] },
        { id: "owned", installed: true, events: [{ id: "owned-event" }] },
      ],
    };
    await m.hydrate(snapshot);
    assert.equal(snapshot.entries[0].media, null);
    assert.equal(snapshot.entries[0].events[0].media, null);
    assert.deepEqual(reads, ["archive", "owned", "owned-event"]);
    const incomplete = catalog.entries.find((e) => e.id === "2011");
    await assert.rejects(inspect(incomplete, data, "bots"), /缺少比赛组件/);
    const root = path.join(data, "incomplete");
    await fs.mkdir(path.join(root, "dota"), { recursive: true });
    await fs.writeFile(path.join(root, "dota.exe"), "fixture");
    await fs.writeFile(path.join(root, "dota/steam.inf"), "fixture");
    const fixture = {
      ...incomplete,
      sha: await require("../src/backend/files.cjs").hash(
        path.join(root, "dota/steam.inf"),
      ),
    };
    const lib = await new Library({ entries: [fixture] }, data).load();
    await lib.bind("2011", root);
    const state = (await lib.snapshot()).entries[0];
    assert.equal(state.archived, true);
    assert.equal(state.installed, false);
    assert.equal(state.menuAvailable, true);
    assert.ok((await inspect(fixture, root, "menu")).exe);
    await fs.writeFile(path.join(root, "dota/steam.inf"), "changed");
    assert.equal((await lib.snapshot()).entries[0].archived, false);
    assert.equal((await lib.snapshot()).entries[0].menuAvailable, false);
  } finally {
    await fs.rm(data, { recursive: true, force: true });
  }
});

test("refresh reads bindings added after startup and clears removed bindings", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-refresh-"));
  try {
    const root = path.join(data, "client");
    await fs.mkdir(path.join(root, "dota"), { recursive: true });
    await fs.writeFile(path.join(root, "dota.exe"), "fixture");
    const inf = path.join(root, "dota/steam.inf");
    await fs.writeFile(inf, "fixture");
    const fixture = {
      id: "fixture",
      playable: true,
      exe: "dota.exe",
      steamInf: "dota/steam.inf",
      sha: await hash(inf),
      events: [],
    };
    const lib = await new Library({ entries: [fixture] }, data).load();
    assert.equal((await lib.snapshot()).entries[0].installed, false);
    await writeJson(lib.configFile, {
      schema: 1,
      roots: { fixture: root },
      packages: {},
    });
    assert.equal((await lib.snapshot()).entries[0].installed, true);
    await writeJson(lib.configFile, { schema: 1, roots: {}, packages: {} });
    assert.equal((await lib.snapshot()).entries[0].installed, false);
    await writeJson(lib.configFile, {
      schema: 1,
      roots: { fixture: root },
      packages: {},
    });
    assert.equal((await lib.snapshot()).entries[0].installed, true);
    await fs.unlink(lib.configFile);
    assert.equal((await lib.snapshot()).entries[0].installed, false);
  } finally {
    await fs.rm(data, { recursive: true, force: true });
  }
});
