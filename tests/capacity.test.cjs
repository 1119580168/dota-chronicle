const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  assertRuntimeCapacity,
  loadPolicy,
} = require("../src/backend/capacity.cjs");
const GIB = 1024 ** 3;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-reserves-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "storage-reserves.json") };
}

test("public defaults do not require a personal drive or reserve", async (t) => {
  const { root } = await fixture(t);
  const policy = await loadPolicy(root);
  assert.equal(Object.keys(policy).length, 0);
  for (const DeviceID of ["M:", "Q:", "C:"])
    assert.doesNotThrow(() =>
      assertRuntimeCapacity({ DeviceID, FreeSpace: 1 }, policy),
    );
  assert.doesNotThrow(() => assertRuntimeCapacity(null));
});

test("configured boundary and drive letters are case insensitive", async (t) => {
  const { root, file } = await fixture(t);
  await fs.writeFile(
    file,
    JSON.stringify({ schema: 1, reservesGiB: { "q:": 5.5 } }),
  );
  const policy = await loadPolicy(root);
  assert.equal(policy["Q:"], 5.5);
  for (const FreeSpace of [0, 5.5 * GIB - 1, 5.5 * GIB])
    assert.throws(
      () => assertRuntimeCapacity({ DeviceID: "q:", FreeSpace }, policy),
      /5.5 GiB/,
    );
  assert.doesNotThrow(() =>
    assertRuntimeCapacity({ DeviceID: "Q:", FreeSpace: 5.5 * GIB + 1 }, policy),
  );
  assert.doesNotThrow(() =>
    assertRuntimeCapacity({ DeviceID: "C:", FreeSpace: 1 }, policy),
  );
  assert.throws(() => assertRuntimeCapacity(null, policy), /无法读取/);
  assert.throws(
    () =>
      assertRuntimeCapacity({ DeviceID: "Q:", FreeSpace: "unknown" }, policy),
    /无法读取/,
  );
});

test("malformed or unsupported policy never silently disables its protection", async (t) => {
  const { root, file } = await fixture(t);
  for (const value of [
    "{",
    "null",
    "[]",
    JSON.stringify({ schema: 2, reservesGiB: {} }),
    JSON.stringify({ schema: 1 }),
    JSON.stringify({ schema: 1, reservesGiB: [], extra: true }),
    JSON.stringify({ schema: 1, reservesGiB: { "../Q:": 5 } }),
    JSON.stringify({ schema: 1, reservesGiB: { "Q:": "5" } }),
    JSON.stringify({ schema: 1, reservesGiB: { "Q:": -1 } }),
    JSON.stringify({ schema: 1, reservesGiB: { "Q:": 16385 } }),
    JSON.stringify({ schema: 1, reservesGiB: { "q:": 1, "Q:": 2 } }),
  ]) {
    await fs.writeFile(file, value);
    await assert.rejects(loadPolicy(root));
  }
  assert.throws(() => assertRuntimeCapacity(null, { "Q:": Infinity }));
  assert.throws(() => assertRuntimeCapacity(null, { "Q:": NaN }));
  await fs.writeFile(file, " ".repeat(16385));
  await assert.rejects(loadPolicy(root), /16 KiB/);
  await fs.rm(file);
  await fs.mkdir(file);
  await assert.rejects(loadPolicy(root), /普通文件/);
});

test("reading failures and a policy removed during reading propagate", async (t) => {
  const { root, file } = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ schema: 1, reservesGiB: {} }));
  for (const code of ["EACCES", "ENOENT", "EIO"]) {
    const read = t.mock.method(fs, "readFile", async () => {
      throw Object.assign(new Error("synthetic read failure"), { code });
    });
    try {
      await assert.rejects(loadPolicy(root), (error) => error.code === code);
    } finally {
      read.mock.restore();
    }
  }
});

test("a linked data parent is rejected even when the policy is missing", async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, "actual");
  const linked = path.join(root, "linked");
  await fs.mkdir(target);
  await fs.symlink(
    target,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(loadPolicy(linked), /链接|联接/);
});

test("a linked policy file is rejected", async (t) => {
  const { root, file } = await fixture(t);
  const target = path.join(root, "original.json");
  await fs.writeFile(target, JSON.stringify({ schema: 1, reservesGiB: {} }));
  try {
    await fs.symlink(target, file, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(
        "file symlink creation unavailable; parent junction rejection is separately checked",
      );
      return;
    }
    throw error;
  }
  await assert.rejects(loadPolicy(root), /链接|联接/);
});
