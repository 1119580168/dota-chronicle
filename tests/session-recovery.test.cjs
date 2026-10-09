const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const recovery = require("../src/backend/session-recovery.cjs");
const files = require("../src/backend/files.cjs");
const { exportBindings } = require("../src/backend/storage.cjs");
const id = "a1234567-1234-1234-1234-123456789012";
const fingerprint = "a".repeat(64);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const folder = path.join(data, "sessions", id);
  await fs.mkdir(folder, { recursive: true });
  const ownership = {
    schema: 1,
    machineUser: fingerprint,
    dataDirectory: data,
  };
  const state = {
    id,
    entry: { id: "7.19" },
    root: path.join(root, "unlaunchable-client"),
    mode: "menu",
    type: "client",
    stage: "recovery-required",
    ownership,
    lock: path.join(data, "client.lock"),
    createdUtc: "2026-10-09T00:00:00Z",
  };
  await fs.mkdir(state.lock);
  return { root, data, folder, ownership, state };
}

test("ownership returns only a machine/user digest computed in the PowerShell subprocess", async () => {
  let command;
  const owner = await recovery.ownership(path.resolve("isolated-profile"), {
    ps: async (script) => {
      command = script;
      return fingerprint;
    },
  });
  assert.equal(owner.machineUser, fingerprint);
  assert.match(command, /SHA256.*ComputeHash/);
  assert.match(command, /WindowsIdentity/);
  assert.deepEqual(Object.keys(owner), [
    "schema",
    "machineUser",
    "dataDirectory",
  ]);
  await assert.rejects(
    recovery.ownership("profile", { ps: async () => "invalid" }),
    /归属/,
  );
});

test("legacy, other machine/user, moved data and invalid locks retain a concrete recovery path", async (t) => {
  const { state, ownership, folder, root } = await fixture(t);
  assert.equal(recovery.plan(state, folder, ownership).allowed, true);
  for (const [candidate, location, owner, code] of [
    [{ ...state, ownership: undefined }, folder, ownership, "legacy"],
    [state, folder, { ...ownership, machineUser: "b".repeat(64) }, "foreign"],
    [state, path.join(root, "moved", "sessions", id), ownership, "moved"],
    [
      { ...state, lock: path.join(root, "unrelated", "client.lock") },
      folder,
      ownership,
      "invalid-lock",
    ],
  ]) {
    const decision = recovery.plan(candidate, location, owner);
    assert.equal(decision.code, code);
    assert.equal(decision.allowed, false);
    assert.match(decision.guidance, /原电脑、原 Windows 用户和原数据目录/);
    assert.match(decision.guidance, /导出绑定到全新 data/);
  }
});

async function runWorker(
  state,
  folder,
  machineUser = fingerprint,
  gameQueryError = false,
) {
  await files.writeJson(path.join(folder, "state.json"), state);
  const calls = { identities: 0, cleanup: 0, stop: 0, spawn: 0 };
  const windows = {
    ps: async () => machineUser,
    identity: async (pid) => {
      calls.identities++;
      if (pid !== 42 && gameQueryError) throw Error("isolated CIM failure");
      return pid === 42
        ? {
            ProcessId: 42,
            ExecutablePath: "unlaunchable-worker.exe",
            CreatedUtc: "2026-10-09T00:00:00Z",
          }
        : null;
    },
    sameProcess: (row, expected) =>
      !!row &&
      row.ProcessId === expected.pid &&
      row.ExecutablePath === expected.exe,
    stopOwned: async () => {
      calls.stop++;
      throw Error("unexpected stop");
    },
  };
  const source = await fs.readFile(
    path.join(__dirname, "../src/backend/worker.cjs"),
    "utf8",
  );
  const context = {
    process: {
      argv: ["node", "worker", folder, "--recover"],
      pid: 42,
      execPath: "unlaunchable-worker.exe",
      exit: (code) => {
        calls.exit = code;
      },
    },
    Buffer,
    setTimeout,
    setInterval,
    clearInterval,
    require: (name) => {
      if (name === "./windows.cjs") return windows;
      if (name === "./files.cjs") return files;
      if (name === "./session-recovery.cjs") return recovery;
      if (name === "./leases.cjs")
        return {
          cleanup: async () => {
            calls.cleanup++;
          },
        };
      if (
        name === "./skill-editor.cjs" ||
        name === "./listen-host.cjs" ||
        name === "./capacity.cjs" ||
        name === "./event-catalog.cjs"
      )
        return {};
      if (name === "./plans.cjs") return {};
      if (name === "node:child_process")
        return {
          spawn: () => {
            calls.spawn++;
            throw Error("unexpected launch");
          },
        };
      return require(name);
    },
  };
  await vm.runInNewContext(source, context, {
    filename: "isolated-real-worker.cjs",
  });
  return {
    calls,
    state: await files.readJson(path.join(folder, "state.json")),
  };
}

test("real worker refuses foreign/legacy/moved recovery before any process or lease action", async (t) => {
  const { state, folder, root } = await fixture(t);
  for (const candidate of [
    { ...state, ownership: undefined },
    {
      ...state,
      ownership: { ...state.ownership, machineUser: "b".repeat(64) },
    },
    {
      ...state,
      ownership: {
        ...state.ownership,
        dataDirectory: path.join(root, "original-data"),
      },
      lock: path.join(root, "original-data", "client.lock"),
    },
  ]) {
    const result = await runWorker(
      {
        ...candidate,
        game: { pid: 17, exe: "fixture", createdUtc: "fixture" },
      },
      folder,
    );
    assert.equal(result.state.stage, "recovery-required");
    assert.equal(result.calls.identities, 0);
    assert.equal(result.calls.cleanup, 0);
    assert.equal(result.calls.stop, 0);
    assert.equal(result.calls.spawn, 0);
    assert.equal(result.calls.exit, 1);
    assert.match(result.state.recoveryGuidance, /原电脑/);
    assert.ok((await fs.stat(state.lock)).isDirectory());
  }
});

test("real local worker retry clears a stale failed-stop flag only after its game has exited", async (t) => {
  const { state, folder } = await fixture(t);
  const result = await runWorker(
    {
      ...state,
      recoveryRequired: true,
      cleanupError: "old failure",
      game: {
        pid: 17,
        exe: "unlaunchable-game.exe",
        createdUtc: "2026-10-09T00:00:00Z",
      },
    },
    folder,
  );
  assert.equal(result.state.stage, "finished");
  assert.equal(result.state.recoveryRequired, false);
  assert.equal(result.state.cleanupError, undefined);
  assert.equal(result.calls.cleanup, 1);
  assert.equal(result.calls.stop, 0);
  await assert.rejects(fs.stat(state.lock), { code: "ENOENT" });
});

test("real worker preserves leases when game identity lookup cannot establish exit", async (t) => {
  const { state, folder } = await fixture(t);
  const result = await runWorker(
    {
      ...state,
      game: { pid: 17, exe: "unlaunchable-game.exe", createdUtc: "fixture" },
    },
    folder,
    fingerprint,
    true,
  );
  assert.equal(result.state.stage, "recovery-required");
  assert.equal(result.state.recoveryRequired, true);
  assert.equal(result.calls.cleanup, 0);
  assert.equal(result.calls.stop, 0);
  assert.ok((await fs.stat(state.lock)).isDirectory());
});

test("migrated copies only acknowledge matching completed original recovery with no running identities", async (t) => {
  const { root, state, folder, ownership } = await fixture(t);
  const originalData = path.join(root, "original-data");
  const original = {
    ...state,
    ownership: { ...ownership, dataDirectory: originalData },
    lock: path.join(originalData, "client.lock"),
    stage: "finished",
    route: { restored: true },
    cfg: { restored: true },
    worker: { pid: 7, exe: "fixture", createdUtc: "fixture" },
  };
  const originalFile = path.join(originalData, "sessions", id, "state.json");
  await files.writeJson(originalFile, original);
  const bytes = await fs.readFile(originalFile);
  const copy = { ...original, stage: "recovery-required" };
  const windows = { identity: async () => null, sameProcess: (row) => !!row };
  assert.equal(
    await recovery.acknowledgeRecoveredCopy(
      copy,
      folder,
      { ...ownership, machineUser: "b".repeat(64) },
      windows,
    ),
    null,
  );
  assert.equal(
    await recovery.acknowledgeRecoveredCopy(copy, folder, ownership, {
      ...windows,
      identity: async () => ({ running: true }),
    }),
    null,
  );
  await fs.writeFile(path.join(state.lock, "unexpected-evidence"), "keep");
  await assert.rejects(
    recovery.acknowledgeRecoveredCopy(copy, folder, ownership, windows),
  );
  assert.equal(
    await fs.readFile(path.join(state.lock, "unexpected-evidence"), "utf8"),
    "keep",
  );
  await fs.unlink(path.join(state.lock, "unexpected-evidence"));
  const result = await recovery.acknowledgeRecoveredCopy(
    copy,
    folder,
    ownership,
    windows,
  );
  assert.equal(result.stage, "finished");
  assert.equal(result.recoveredFromDataDirectory, originalData);
  await assert.rejects(fs.stat(state.lock), { code: "ENOENT" });
  assert.deepEqual(
    await fs.readFile(originalFile),
    bytes,
    "original evidence is read-only",
  );
});

test("binding export creates a fresh profile and preserves sessions, locks and source files", async (t) => {
  const { root, data, state, folder } = await fixture(t);
  await files.writeJson(path.join(folder, "state.json"), state);
  await files.writeJson(path.join(data, "media", "index.json"), {
    schema: 1,
    assets: {},
    targets: {},
  });
  const config = { schema: 1, roots: { 7.19: state.root } };
  const evidence = await fs.readFile(path.join(folder, "state.json"));
  const target = await exportBindings(data, root, config);
  assert.deepEqual(
    await files.readJson(path.join(target, "library.json")),
    config,
  );
  assert.deepEqual(
    await files.readJson(path.join(target, "media", "index.json")),
    { schema: 1, assets: {}, targets: {} },
  );
  await assert.rejects(fs.stat(path.join(target, "sessions")), {
    code: "ENOENT",
  });
  await assert.rejects(fs.stat(path.join(target, "client.lock")), {
    code: "ENOENT",
  });
  assert.deepEqual(
    await fs.readFile(path.join(folder, "state.json")),
    evidence,
  );
  assert.ok((await fs.stat(state.lock)).isDirectory());
  await assert.rejects(exportBindings(data, data, config), /之外/);
});
