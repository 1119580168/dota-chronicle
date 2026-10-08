const fs = require("node:fs/promises");
const path = require("node:path");
const {
  exists,
  inside,
  noLinks,
  treeFingerprint,
  hash,
} = require("./files.cjs");
async function prepareAddon(state, save) {
  if (
    state.entry.id !== "6.80c" ||
    !state.event ||
    !["nian", "frostivus"].includes(state.event.addon)
  )
    return;
  const sibling = state.event.addon === "nian" ? "frostivus" : "nian";
  const from = inside(state.root, "dota/addons/" + sibling),
    to = inside(state.root, ".chronicle-staging/" + state.id + "/" + sibling);
  await noLinks(from);
  await noLinks(to);
  if (!(await exists(from))) return;
  state.addon = {
    from,
    to,
    fingerprint: await treeFingerprint(from),
    restored: false,
  };
  await save();
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
}
async function restoreAddon(state) {
  if (!state.addon || state.addon.restored) return;
  const a = state.addon;
  const sibling = state.event.addon === "nian" ? "frostivus" : "nian";
  if (
    a.from !== inside(state.root, "dota/addons/" + sibling) ||
    a.to !==
      inside(state.root, ".chronicle-staging/" + state.id + "/" + sibling)
  )
    throw Error("活动租约路径异常");
  await noLinks(a.from);
  await noLinks(a.to);
  if (await exists(a.to)) {
    if (
      (await exists(a.from)) ||
      (await treeFingerprint(a.to)) !== a.fingerprint
    )
      throw Error("活动目录被外部修改，已保留文件，请人工检查");
    await fs.rename(a.to, a.from);
  } else if (
    !(await exists(a.from)) ||
    (await treeFingerprint(a.from)) !== a.fingerprint
  )
    throw Error("活动目录未能恢复，请人工检查");
  a.restored = true;
}
async function restoreRegistry(state, windows) {
  if (!state.route || state.route.restored) return;
  const r = state.route,
    current = await windows.registryRead(r.name);
  if (current.exists && current.value === r.candidate)
    await windows.registryWrite(r.name, r.original);
  else r.externalChangePreserved = true;
  r.restored = true;
}
async function restoreCfg(state) {
  if (!state.cfg) return;
  const expected = inside(
    state.root,
    (state.entry.source2 ? "game/dota/cfg/" : "dota/cfg/") +
      "chronicle_" +
      state.id +
      ".cfg",
  );
  if (expected !== state.cfg.path) throw Error("临时配置路径异常");
  await noLinks(expected);
  if ((await exists(expected)) && (await hash(expected)) === state.cfg.sha)
    await fs.unlink(expected);
  else if (await exists(expected)) state.cfg.externalChangePreserved = true;
  state.cfg.restored = true;
}
async function cleanup(state, windows) {
  const errors = [];
  for (const run of [
    () => require("./skill-editor.cjs").restore(state),
    () => restoreAddon(state),
    () => restoreRegistry(state, windows),
    () => restoreCfg(state),
  ])
    try {
      await run();
    } catch (e) {
      errors.push(e.message);
    }
  if (errors.length) throw Error(errors.join("；"));
}
module.exports = {
  prepareAddon,
  restoreAddon,
  restoreRegistry,
  restoreCfg,
  cleanup,
};
