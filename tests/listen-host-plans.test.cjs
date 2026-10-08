const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const catalog = require("../resources/catalog.json");
const plans = require("../src/backend/plans.cjs");
const { needsHostBootstrap } = require("../src/backend/listen-host.cjs");
const runtime = { root: path.resolve("fixture") };
const options = {
  host: true,
  room: plans.roomOptions(),
  cfgName: "fixture.cfg",
  log: "native.log",
  packages: {},
  hostBootstrap: { port: 50311, password: "a".repeat(64) },
};
test("All seven pre-7 ordinary listen hosts receive authenticated initialization without practice bots", () => {
  const ids = ["6.77c", "6.78b", "6.80c", "6.81", "6.83", "6.85b", "6.88c"];
  assert.deepEqual(
    catalog.entries.filter((e) => e.listenHostBootstrap).map((e) => e.id),
    ids,
  );
  for (const id of ids) {
    const entry = catalog.entries.find((e) => e.id === id);
    assert.ok(
      needsHostBootstrap({ type: "client", host: true, mode: "bots", entry }),
    );
    const args = plans.buildArgs(entry, "bots", runtime, options);
    assert.equal(args[args.indexOf("-netconport") + 1], "50311");
    assert.equal(
      args[args.indexOf("-netconpassword") + 1],
      options.hostBootstrap.password,
    );
    assert.equal(args.includes("-vconsole"), entry.source2);
    assert.ok(!args.includes("+dota_bot_practice_start"));
    assert.ok(!args.includes("+dota_bot_populate"));
    assert.equal(args[args.indexOf("-ip") + 1], "0.0.0.0");
    assert.equal(args[args.indexOf("-port") + 1], String(options.room.port));
  }
});
test("Host control cannot leak into menu, joining, RPG, newer clients, prototype or dedicated routes", () => {
  const early = catalog.entries.find((e) => e.id === "6.80c");
  for (const mode of ["menu", "join", early.events[0].id]) {
    assert.throws(
      () =>
        plans.buildArgs(early, mode, runtime, {
          ...options,
          join: "127.0.0.1",
        }),
      /不允许/,
    );
    assert.equal(
      needsHostBootstrap({ type: "client", host: true, mode, entry: early }),
      false,
    );
  }
  for (const entry of catalog.entries.filter(
    (e) => e.playable && !e.listenHostBootstrap,
  )) {
    assert.equal(
      needsHostBootstrap({ type: "client", host: true, mode: "bots", entry }),
      false,
    );
    assert.throws(
      () => plans.buildArgs(entry, "bots", runtime, options),
      /不允许/,
    );
  }
  assert.equal(
    needsHostBootstrap({
      type: "dedicated",
      host: true,
      mode: "bots",
      entry: early,
    }),
    false,
  );
  assert.equal(
    needsHostBootstrap({
      type: "client",
      host: false,
      mode: "bots",
      entry: early,
    }),
    false,
  );
});
test("Malformed control inputs are rejected before process creation", () => {
  const entry = catalog.entries.find((e) => e.id === "6.77c");
  for (const hostBootstrap of [
    { port: 1, password: "a".repeat(64) },
    { port: 50311, password: "short" },
    { port: 50311, password: "a".repeat(63) + "\n" },
    { port: "50311;quit", password: "a".repeat(64) },
  ])
    assert.throws(
      () =>
        plans.buildArgs(entry, "bots", runtime, { ...options, hostBootstrap }),
      /参数无效/,
    );
});
