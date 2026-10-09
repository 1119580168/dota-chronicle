const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const plans = require("../src/backend/plans.cjs");

async function launchHarness() {
  const source = await fs.readFile(
    path.join(__dirname, "../src/main.cjs"),
    "utf8",
  );
  const calls = { networks: 0, guardian: 0 };
  const entry = { id: "7.19", playable: true };
  const ownership = {
    schema: 1,
    machineUser: "a".repeat(64),
    dataDirectory: path.resolve("fixture-data"),
  };
  const context = {
    busy: false,
    path,
    data: ownership.dataDirectory,
    crypto: { randomUUID: () => "a1234567-1234-1234-1234-123456789012" },
    fs: { mkdir: async () => {} },
    f: {
      writeJson: async (_file, state) => {
        calls.state = state;
      },
    },
    library: {
      config: {
        roots: { 7.19: "fixture-client" },
        room: { bind: "192.0.2.99" },
        packages: {},
      },
      load: async () => {},
      entry: () => entry,
      save: async () => {},
      launchOptionsFor: async () => ({ language: "schinese" }),
    },
    assertSkillEditorMode: () => {},
    inspect: async () => ({ root: path.resolve("unlaunchable-client") }),
    roomOptions: plans.roomOptions,
    serverAddress: plans.serverAddress,
    networks: () => {
      calls.networks++;
      return [{ address: "192.0.2.20" }];
    },
    sessions: async () => [],
    currentOwner: async () => ownership,
    diskResource: (file) => file,
    guardian: async () => {
      calls.guardian++;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    source.slice(
      source.indexOf("function publicSession("),
      source.indexOf("function register("),
    ),
    context,
  );
  return { context, calls, ownership };
}

test("real launch ignores saved stale host interfaces for menu, match, RPG and joining", async () => {
  for (const mode of ["menu", "bots", "fixture-rpg", "join"]) {
    const { context, calls, ownership } = await launchHarness();
    const result = await context.launch({
      id: "7.19",
      mode,
      server: "192.0.2.10",
    });
    assert.equal(calls.networks, 0, mode);
    assert.equal(calls.guardian, 1, mode);
    assert.equal(calls.state.ownership, ownership);
    assert.equal(
      result.ownership,
      undefined,
      "machine/user digest stays private",
    );
  }
});

test("real host launch rejects stale interfaces with an explicit reselect/save path", async () => {
  const { context, calls } = await launchHarness();
  await assert.rejects(
    context.launch({ id: "7.19", mode: "bots", host: true }),
    /重新选择监听网卡并保存/,
  );
  assert.equal(calls.guardian, 0);
  assert.equal(calls.networks, 1);
  await context.launch({
    id: "7.19",
    mode: "bots",
    host: true,
    room: { bind: "192.0.2.20" },
  });
  assert.equal(calls.guardian, 1);
});

async function uiFunctions() {
  const source = await fs.readFile(
    path.join(__dirname, "../src/ui/app.js"),
    "utf8",
  );
  const context = {
    esc: (value) =>
      String(value ?? "")
        .replaceAll("<", "&lt;")
        .replaceAll('"', "&quot;"),
    icon: () => "",
    allEvents: () => [],
    activeStages: ["recovery-required"],
    stageText: { "recovery-required": "需要恢复检查" },
    skillEditorPhaseText: {},
    store: {
      sessions: [
        {
          id: "fixture",
          version: "7.19",
          type: "client",
          stage: "recovery-required",
          mode: "menu",
          recoveryGuidance: "请回原位置恢复 <保留旧证据>",
        },
      ],
      entries: [{ id: "7.19", playable: true, installed: true }],
      networks: [],
    },
    draft: { bind: "192.0.2.99", port: 27015, password: "fixture" },
    roomVersion: "7.19",
    roomMode: "bots",
    roomEvent: () => undefined,
    languageSelector: () => "",
    roomEvents: () => "",
    roomCanLaunch: () => true,
  };
  vm.createContext(context);
  for (const [start, end] of [
    ["function mediaGallery(", "function findMedia("],
    ["function room()", "function libraryView("],
    ["function sessionsPanel(", "function connectionCode("],
  ])
    vm.runInContext(
      source.slice(source.indexOf(start), source.indexOf(end)),
      context,
    );
  return context;
}

test("session UI exposes recovery guidance, retry and fresh binding export without a stop bypass", async () => {
  const context = await uiFunctions();
  const html = context.sessionsPanel();
  assert.match(html, /data-recover="fixture"/);
  assert.match(html, /data-action="exportBindings"/);
  assert.match(html, /&lt;保留旧证据>/);
  assert.doesNotMatch(html, /data-stop=/);
});

test("room UI identifies the stale saved interface and offers an explicit save action", async () => {
  const context = await uiFunctions();
  const html = context.room();
  assert.match(html, /已失效 · 192\.0\.2\.99/);
  assert.match(html, /data-testid="room-bind-error"/);
  assert.match(html, /data-action="saveRoom"/);
});

test("unreadable media renders its repair error and removes import actions", async () => {
  const context = await uiFunctions();
  const html = context.mediaGallery({
    media: { status: { canImport: false, error: "媒体索引不可用 <损坏>" } },
  });
  assert.match(html, /data-testid="media-error"/);
  assert.match(html, /媒体索引不可用 &lt;损坏>/);
  assert.match(html, /data-action="refresh"/);
  assert.doesNotMatch(html, /data-import-media/);
});
