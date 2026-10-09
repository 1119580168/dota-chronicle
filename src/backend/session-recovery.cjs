const fs = require("node:fs/promises");
const path = require("node:path");
const f = require("./files.cjs");

const activeStages = [
  "queued",
  "starting",
  "loading",
  "running",
  "stopping",
  "restoring",
  "recovery-required",
];
const samePath = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function ownership(data, windows) {
  const raw = await windows.ps(
    "$machineId=(Get-ItemPropertyValue -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid);$accountSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
      "if($machineId -notmatch '^[a-f0-9-]{36}$' -or $accountSid -notmatch '^S-1-\\d+(?:-\\d+)+$'){throw '无法确认本机与 Windows 用户归属'};" +
      "$ownerHash=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($ownerHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($machineId.ToLowerInvariant()+\"`n\"+$accountSid))).Replace('-','').ToLowerInvariant()}finally{$ownerHash.Dispose()}",
  );
  if (!/^[a-f0-9]{64}$/.test(raw))
    throw Error("无法确认本机与 Windows 用户归属，已保留会话租约");
  return {
    schema: 1,
    machineUser: raw,
    dataDirectory: path.resolve(data),
  };
}

function plan(state, folder, current) {
  const data = path.dirname(path.dirname(path.resolve(folder)));
  const origin = state.ownership;
  const originalData =
    origin?.dataDirectory ||
    (typeof state.lock === "string" &&
    path.isAbsolute(state.lock) &&
    path.basename(state.lock).toLowerCase() === "client.lock"
      ? path.dirname(state.lock)
      : "");
  const original = originalData ? `原数据目录：${originalData}。` : "";
  const guidance =
    original +
    "请在原电脑、原 Windows 用户和原数据目录中用原启动器结束游戏并完成恢复；再重新复制已恢复的 data。若要先继续使用，可导出绑定到全新 data，并保留旧 data 和客户端暂存文件供原位置恢复。";
  const blocked = (code, reason) => ({
    allowed: false,
    code,
    reason,
    guidance,
    originalDataDirectory: originalData,
  });
  if (
    !/^[a-f0-9-]{36}$/.test(state.id || "") ||
    path.basename(folder) !== state.id ||
    path.basename(path.dirname(folder)).toLowerCase() !== "sessions"
  )
    return blocked("invalid-session", "会话目录与标识不一致，已保留恢复证据");
  if (
    !origin ||
    origin.schema !== 1 ||
    !/^[a-f0-9]{64}$/.test(origin.machineUser || "") ||
    typeof origin.dataDirectory !== "string" ||
    !path.isAbsolute(origin.dataDirectory)
  )
    return blocked(
      "legacy",
      "旧会话缺少机器归属，不能自动恢复注册表或旧客户端路径",
    );
  if (!current)
    return blocked(
      "ownership-unavailable",
      "无法确认本机与 Windows 用户归属，已保留会话租约",
    );
  if (current.machineUser !== origin.machineUser)
    return blocked("foreign", "会话属于其他电脑或 Windows 用户，已保留旧租约");
  if (
    state.lock &&
    (state.type === "dedicated" ||
      !samePath(state.lock, path.join(origin.dataDirectory, "client.lock")))
  )
    return blocked("invalid-lock", "客户端锁路径异常，已保留租约供原位置检查");
  if (!samePath(data, origin.dataDirectory))
    return blocked("moved", "data 已迁移；请先在原位置完成会话恢复");
  return { allowed: true };
}

function blockedState(state, decision) {
  return {
    ...state,
    stage: "recovery-required",
    cleanupError: decision.reason,
    recoveryGuidance: decision.guidance,
    recoveryCode: decision.code,
  };
}

// A migrated copy can acknowledge completed recovery at the original location.
// It never runs cleanup against the original registry, client or lock path.
async function acknowledgeRecoveredCopy(
  state,
  folder,
  current,
  windows,
  peers = [],
) {
  const decision = plan(state, folder, current);
  if (decision.code !== "moved") return null;
  const originalFile = path.join(
    state.ownership.dataDirectory,
    "sessions",
    state.id,
    "state.json",
  );
  await f.noLinks(originalFile);
  let original;
  try {
    original = await f.readJson(originalFile);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (
    !["finished", "failed"].includes(original.stage) ||
    original.recoveryRequired === true ||
    [
      original.route,
      original.addon,
      original.cfg,
      original.skillEditorLease,
    ].some((lease) => lease && lease.restored !== true) ||
    original.id !== state.id ||
    original.root !== state.root ||
    original.entry?.id !== state.entry?.id ||
    original.mode !== state.mode ||
    original.type !== state.type ||
    !plan(original, path.dirname(originalFile), current).allowed ||
    original.ownership.machineUser !== state.ownership.machineUser ||
    (state.lock && !samePath(original.lock, state.lock))
  )
    return null;
  for (const identity of [
    original.worker,
    original.game,
    state.worker,
    state.game,
  ])
    if (
      identity &&
      windows.sameProcess(await windows.identity(identity.pid), identity)
    )
      return null;
  if (
    state.type !== "dedicated" &&
    peers.some(
      (peer) =>
        peer.id !== state.id &&
        peer.type !== "dedicated" &&
        activeStages.includes(peer.stage),
    )
  )
    return null;
  if (state.lock) {
    const copiedLock = path.join(
      path.dirname(path.dirname(folder)),
      "client.lock",
    );
    await f.noLinks(copiedLock);
    try {
      // rmdir only accepts an empty real directory: unexpected contents survive.
      await fs.rmdir(copiedLock);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return {
    ...original,
    recoveryCode: undefined,
    recoveryGuidance: undefined,
    cleanupError: undefined,
    recoveredFromDataDirectory: state.ownership.dataDirectory,
  };
}

module.exports = {
  activeStages,
  ownership,
  plan,
  blockedState,
  acknowledgeRecoveredCopy,
};
