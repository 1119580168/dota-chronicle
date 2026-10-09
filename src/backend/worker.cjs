// Detached process guardian: the window may close while the game keeps running.
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const f = require("./files.cjs"),
  w = require("./windows.cjs"),
  lease = require("./leases.cjs");
const {
  inspect,
  buildArgs,
  buildClientCfg,
  roomOptions,
} = require("./plans.cjs");
const { needsHostBootstrap, waitAndJoin } = require("./listen-host.cjs");
const skillEditor = require("./skill-editor.cjs");
const { assertRuntimeCapacity, loadPolicy } = require("./capacity.cjs");
const { trustedEntryForSession, catalogFile } = require("./event-catalog.cjs");
const recovery = require("./session-recovery.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folder = path.resolve(process.argv[2]);
const stateFile = path.join(folder, "state.json");
let state,
  game,
  ownsClientLock = false,
  mayUseLeases = false,
  controlPassword;
const save = () => f.writeJson(stateFile, state);
const request = path.join(folder, "stop.request");
async function awaitIdentity(pid, exe) {
  for (let i = 0; i < 12; i++) {
    const p = await w.identity(pid);
    if (p && p.ExecutablePath?.toLowerCase() === exe.toLowerCase())
      return { pid, exe, createdUtc: p.CreatedUtc };
    await sleep(150);
  }
  throw Error("无法确认新进程身份，请检查启动日志");
}
async function monitorOwned() {
  for (;;) {
    const p = await w.identity(state.game.pid);
    if (!w.sameProcess(p, state.game)) break;
    if (await f.exists(request)) {
      state.stage = "stopping";
      await save();
      await w.stopOwned(state.game);
    }
    await sleep(1500);
  }
}
async function freeControlPort() {
  // Ask the OS for an ephemeral port. The native console authenticates every
  // connection; its one-time secret stays inside this worker, never in the UI.
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  await w.portFree(port);
  return port;
}
async function scrubControlSecret() {
  if (!controlPassword || !state?.entry?.source2) return;
  const file = path.join(folder, "native.log");
  if (!(await f.exists(file))) return;
  await f.noLinks(file);
  const fd = await fs.open(file, "r+");
  // Same-size positional writes preserve game-owned appends and byte offsets.
  try {
    const bytes = Buffer.alloc(65536);
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    const secret = Buffer.from(controlPassword);
    let offset = bytes.subarray(0, bytesRead).indexOf(secret);
    while (offset >= 0) {
      await fd.write(Buffer.alloc(secret.length, 42), 0, secret.length, offset);
      offset = bytes.indexOf(secret, offset + secret.length);
    }
  } finally {
    await fd.close();
  }
}
async function ownsControlPort(port, { connected = false } = {}) {
  if (!w.sameProcess(await w.identity(state.game.pid), state.game))
    return false;
  const owner = await w.ps(
    `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
  );
  return Number(owner) === state.game.pid || (!connected && !owner);
}
async function monitorSkillEditor(control, exited) {
  let finished = false;
  const scrub = async () => {
    try {
      await scrubControlSecret();
    } catch {
      state.skillEditorError ||= "技能控制日志脱敏失败，请勿分享原生日志";
      await save();
    }
  };
  const isStopping = async () =>
    finished ||
    (await f.exists(request)) ||
    !w.sameProcess(await w.identity(state.game.pid), state.game);
  const phase = async (value) => {
    if (finished || (await f.exists(request))) return;
    if (state.skillEditorPhase !== value) {
      state.skillEditorPhase = value;
      await save();
    }
  };
  const scrubber = setInterval(() => {
    scrub().catch(() => {});
  }, 2000);
  const loading = Promise.resolve()
    .then(() =>
      skillEditor.waitAndLoad({
        ...control,
        profile: skillEditor.profile(state),
        isOwned: (connection) => ownsControlPort(control.port, connection),
        isStopping,
        onPhase: phase,
        onReady: () => phase("ready"),
        timeoutMs: 30 * 60 * 1000,
        continuous: true,
      }),
    )
    .catch(async (error) => {
      if (await isStopping()) return;
      // A tool failure must leave the user's otherwise usable menu/game alive.
      state.skillEditorPhase = "error";
      state.skillEditorError = String(error.message || "技能面板加载失败")
        .split(controlPassword)
        .join("[redacted]")
        .slice(0, 500);
      await save();
    });
  try {
    await scrub();
    await Promise.race([exited, monitorOwned()]);
  } finally {
    finished = true;
    clearInterval(scrubber);
    await loading;
    await scrub();
  }
}
async function prototypeStart(password) {
  let sock,
    buffer = "";
  for (let i = 0; i < 90; i++) {
    if (game.exitCode !== null) throw Error("原型客户端在加载时退出");
    try {
      sock = await new Promise((resolve, reject) => {
        const s = net.connect({ host: "127.0.0.1", port: 27111 });
        s.setTimeout(750);
        s.once("connect", () => resolve(s));
        s.once("error", (e) => {
          s.destroy();
          reject(e);
        });
        s.once("timeout", () => {
          s.destroy();
          reject(Error("timeout"));
        });
      });
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!sock) throw Error("原型控制台启动超时");
  sock.on("data", (data) => {
    buffer = (buffer + data.toString()).slice(-100000);
  });
  sock.on("error", () => {});
  sock.setTimeout(0);
  const send = async (command) => {
    buffer = "";
    sock.write(command + "\n");
    await sleep(700);
    return buffer;
  };
  try {
    await send("PASS " + password);
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const out = await send("status");
      if (/map\s*:\s*dota\b/.test(out) && /1 humans/.test(out)) {
        ready = true;
        break;
      }
      if (game.exitCode !== null) break;
    }
    if (!ready) throw Error("原型地图未进入可操作状态");
    await send("cmd dota_select_team good");
    await send("cmd dota_select_hero npc_dota_hero_lina");
    await sleep(800);
    await send("dota_bot_populate");
    let bots = false;
    for (let i = 0; i < 15; i++)
      if (/1 humans, 9 bots/.test(await send("status"))) {
        bots = true;
        break;
      }
    if (!bots) throw Error("原型尚未建立 9 个机器人席位");
    await send("hideconsole");
    await send("gameui_hide");
    await send("dota_camera_center");
  } finally {
    sock.destroy();
  }
}
async function startClient() {
  const rootLock = path.join(path.dirname(path.dirname(folder)), "client.lock");
  try {
    await fs.mkdir(rootLock);
    ownsClientLock = true;
    state.lock = rootLock;
    await save();
  } catch (e) {
    if (e.code === "EEXIST")
      throw Error("已有客户端启动任务或恢复任务，请先结束它");
    throw e;
  }
  const list = await w.processes();
  if (
    list.some(
      (p) =>
        !p.ExecutablePath?.toLowerCase().endsWith("steam.exe") &&
        !/(?:^|\s)-dedicated(?:\s|$)/i.test(p.CommandLine || ""),
    )
  )
    throw Error("其他 Dota 客户端正在运行，请先退出");
  if (!list.some((p) => p.ExecutablePath?.toLowerCase().endsWith("steam.exe")))
    throw Error("请先打开 Steam 并使用自己的账户登录，再启动旧客户端");
  const runtime = await inspect(
    state.entry,
    state.root,
    state.mode,
    state.packages,
    state.joinMode,
  );
  state.root = runtime.root;
  state.event = runtime.event;
  const room = roomOptions(state.room);
  state.room = room;
  await w.portFree(
    state.host ? room.port : state.entry.prototype ? 27110 : 27491,
  );
  if (state.entry.prototype && state.mode === "bots") await w.portFree(27111);
  const disk = await w.diskSpace(state.root);
  assertRuntimeCapacity(
    disk,
    await loadPolicy(path.dirname(path.dirname(folder))),
  );
  const cfgName = "chronicle_" + state.id + ".cfg",
    cfgPath = f.inside(
      state.root,
      (state.entry.source2 ? "game/dota/cfg/" : "dota/cfg/") + cfgName,
    );
  await f.noLinks(cfgPath);
  await fs.writeFile(cfgPath, buildClientCfg(state), { flag: "wx" });
  state.cfg = { path: cfgPath, sha: await f.hash(cfgPath) };
  await save();
  await lease.prepareAddon(state, save);
  if (skillEditor.enabled(state)) {
    await skillEditor.prepare(state, save);
    state.skillEditorPhase =
      skillEditor.profile(state) === "727c-aghanim-v1"
        ? "waiting-labyrinth"
        : "waiting-demo";
    await save();
  }
  if (!state.entry.prototype) {
    const name = state.entry.source2 ? "SteamClientDll64" : "SteamClientDll";
    state.route = {
      name,
      original: await w.registryRead(name),
      candidate: await w.steamDll(state.entry.source2),
      restored: false,
    };
    await save();
    await w.registryWrite(name, {
      exists: true,
      value: state.route.candidate,
      kind: "String",
    });
  }
  const password = crypto.randomBytes(24).toString("hex");
  let hostBootstrap, skillBootstrap;
  if (needsHostBootstrap(state)) {
    controlPassword = crypto.randomBytes(32).toString("hex");
    hostBootstrap = {
      port: await freeControlPort(),
      password: controlPassword,
    };
  }
  if (skillEditor.enabled(state)) {
    controlPassword = crypto.randomBytes(32).toString("hex");
    skillBootstrap = {
      port: await freeControlPort(),
      password: controlPassword,
    };
  }
  const args = buildArgs(state.entry, state.mode, runtime, {
    id: state.id,
    log: path.join(folder, "native.log"),
    host: state.host,
    room,
    join: state.join,
    joinMode: state.joinMode,
    cfgName,
    packages: state.packages,
    language: state.language,
    prototypePassword: password,
    hostBootstrap,
    skillBootstrap,
  });
  if (skillBootstrap && (await f.exists(request))) {
    const cancelled = Error("技能工具启动已取消");
    cancelled.code = "LISTEN_HOST_CANCELLED";
    throw cancelled;
  }
  game = spawn(runtime.exe, args, {
    cwd: state.root,
    windowsHide: false,
    stdio: "ignore",
  });
  const exited = new Promise((resolve, reject) => {
    game.once("exit", (code, signal) => resolve({ code, signal }));
    game.once("error", reject);
  });
  // Attach a rejection handler immediately; spawning can fail before CIM inspection completes.
  exited.catch(() => {});
  if (!game.pid) await exited;
  state.game = await awaitIdentity(game.pid, runtime.exe);
  state.stage = hostBootstrap ? "loading" : "running";
  state.startedUtc = new Date().toISOString();
  await save();
  if (hostBootstrap) {
    state.hostReady = await waitAndJoin({
      ...hostBootstrap,
      source2: state.entry.source2 === true,
      isOwned: (connection) => ownsControlPort(hostBootstrap.port, connection),
      isStopping: () => f.exists(request),
      onPhase: async (phase) => {
        state.hostBootstrapPhase = phase;
        await save();
      },
    });
    await scrubControlSecret();
    state.stage = "running";
    await save();
  }
  if (state.entry.prototype && state.mode === "bots") {
    state.stage = "loading";
    await save();
    await prototypeStart(password);
    state.stage = "running";
    state.prototypeBotsVerified = true;
    await save();
  }
  if (skillBootstrap) await monitorSkillEditor(skillBootstrap, exited);
  else await Promise.race([exited, monitorOwned()]);
  state.exitCode = game.exitCode;
  state.stage = "restoring";
  await save();
}
async function startServer() {
  const room = roomOptions(state.room);
  state.room = room;
  const runtime = await inspect(state.entry, state.root, "menu", {});
  state.root = runtime.root;
  await f.noLinks(f.inside(state.root, "game/dota/scripts/vscripts"));
  await f.noLinks(f.inside(state.root, "game/dota/cfg"));
  const privateDir = path.join(folder, "server");
  await fs.mkdir(privateDir, { recursive: true });
  const script = path.join(state.serverResources, "start-standard-server.ps1");
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-ClientRoot",
    state.root,
    "-Port",
    String(room.port),
    "-GamePassword",
    room.password,
    "-StateDirectory",
    privateDir,
    "-BindAddress",
    room.bind || "0.0.0.0",
    "-SessionId",
    state.id,
  ];
  if (room.internet) args.push("-Internet");
  const fd = await fs.open(path.join(folder, "server-setup.log"), "a");
  const starter = spawn(w.psExe, args, {
    windowsHide: true,
    stdio: ["ignore", fd.fd, fd.fd],
    env: w.psEnv,
  });
  let result = null,
    error = null;
  starter.once("error", (e) => {
    error = e;
    result = -1;
  });
  starter.once("exit", (code) => {
    result = code;
  });
  const deadline = Date.now() + 90000;
  while (result === null && Date.now() < deadline) {
    const p = path.join(privateDir, "server-state.json");
    if (await f.exists(p))
      try {
        const info = await f.readJson(p);
        state.game = {
          pid: info.pid,
          exe: info.exe,
          createdUtc: info.startTime,
        };
        state.nativeLog = info.log;
        if (
          info.configFile ===
          f.inside(
            state.root,
            "game/dota/cfg/chronicle_server_" + state.id + ".cfg",
          )
        ) {
          state.serverCfg = info.configFile;
          state.serverCfgHash = info.configSha256.toLowerCase();
        }
        await save();
      } catch {}
    if (await f.exists(request)) {
      if (state.game) await w.stopOwned(state.game);
      starter.kill();
      break;
    }
    await sleep(500);
  }
  await fd.close();
  if (result === null) {
    starter.kill();
    throw Error("专服准备超时，请检查服务器日志");
  }
  if (error || result !== 0)
    throw Error("专服启动未通过。请打开日志查看构建校验或开局诊断。");
  const info = await f.readJson(path.join(privateDir, "server-state.json"));
  state.game = { pid: info.pid, exe: info.exe, createdUtc: info.startTime };
  state.stage = "running";
  state.startedUtc = new Date().toISOString();
  await save();
  await monitorOwned();
}
async function run() {
  await f.noLinks(stateFile);
  state = await f.readJson(stateFile);
  if (!/^[a-f0-9-]{36}$/.test(state.id) || path.basename(folder) !== state.id)
    throw Error("Invalid session folder");
  // Check machine, Windows user and original data location before consulting
  // saved process identities or touching any registry/client lifecycle lease.
  const owner = await recovery.ownership(path.dirname(path.dirname(folder)), w);
  const decision = recovery.plan(state, folder, owner);
  if (!decision.allowed) {
    state = recovery.blockedState(state, decision);
    throw Error(decision.reason);
  }
  if (
    process.argv.includes("--recover") &&
    state.worker &&
    w.sameProcess(await w.identity(state.worker.pid), state.worker)
  )
    throw Error("原守护进程仍在运行，请等待它结束或在界面结束本程序会话");
  mayUseLeases = true;
  delete state.cleanupError;
  delete state.recoveryGuidance;
  delete state.recoveryCode;
  state.worker = await awaitIdentity(process.pid, process.execPath);
  state.stage = "starting";
  await save();
  if (process.argv.includes("--recover")) {
    if (
      state.game &&
      w.sameProcess(await w.identity(state.game.pid), state.game)
    ) {
      state.stage = "running";
      await save();
      await monitorOwned();
    }
    // A prior failed stop remains an active lease until this owned process has
    // actually exited. Only then can a retry clear the persisted safety flag.
    state.recoveryRequired = false;
  } else {
    state.entry = trustedEntryForSession(
      await f.readJson(catalogFile()),
      state,
    );
    if (state.type === "dedicated") await startServer();
    else await startClient();
  }
}
run()
  .catch(async (e) => {
    if (!state) return;
    if (!mayUseLeases) {
      state.stage = "recovery-required";
      state.cleanupError ||= e.message;
      state.recoveryGuidance ||=
        "保留旧 data 与客户端暂存文件。请在原电脑、原 Windows 用户和原数据目录完成恢复，或导出绑定到全新 data；导出不会恢复旧客户端或 Steam 租约。";
      return;
    }
    if (e.code !== "LISTEN_HOST_CANCELLED") state.error = e.message;
    let gameIdentity;
    if (state.game)
      try {
        gameIdentity = await w.identity(state.game.pid);
      } catch (check) {
        state.error += "；无法确认游戏进程是否已退出：" + check.message;
        state.recoveryRequired = true;
        return;
      }
    if (state.game && w.sameProcess(gameIdentity, state.game))
      try {
        await w.stopOwned(state.game);
      } catch (stop) {
        state.error += "；" + stop.message;
        state.recoveryRequired = true;
      }
  })
  .finally(async () => {
    if (!state) return;
    try {
      if (!mayUseLeases) throw Error(state.cleanupError);
      if (state.recoveryRequired)
        throw Error("进程仍可能在使用资源，保留租约等待恢复");
      await scrubControlSecret().catch(() => {
        state.error ||= "本地控制日志脱敏失败，请勿分享原生日志";
      });
      await lease.cleanup(state, w);
      if (
        state.serverCfg &&
        (await f.exists(state.serverCfg)) &&
        (await f.hash(state.serverCfg)) === state.serverCfgHash
      )
        await fs.unlink(state.serverCfg);
      if (state.lock) {
        const currentLock = path.join(
          path.dirname(path.dirname(folder)),
          "client.lock",
        );
        await f.noLinks(currentLock);
        await fs.rmdir(currentLock).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      }
      state.stage = state.error ? "failed" : "finished";
    } catch (e) {
      state.stage = "recovery-required";
      state.cleanupError = e.message;
    }
    state.finishedUtc = new Date().toISOString();
    await save();
    process.exit(state.error || state.stage === "recovery-required" ? 1 : 0);
  });
