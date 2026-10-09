const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  net,
  Menu,
  clipboard,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const f = require("./backend/files.cjs"),
  w = require("./backend/windows.cjs");
const { Library, networks } = require("./backend/library.cjs");
const { MediaLibrary } = require("./backend/media.cjs");
const { hydrateHistory, orderClients } = require("./backend/history.cjs");
const { archiveFolder } = require("./backend/archives.cjs");
const {
  dataDirectory,
  prepareStorage,
  exportBindings,
} = require("./backend/storage.cjs");
const recovery = require("./backend/session-recovery.cjs");
const { roomOptions, serverAddress, inspect } = require("./backend/plans.cjs");
const { assertSkillEditorMode } = require("./backend/event-catalog.cjs");
const { assertRuntimeCapacity, loadPolicy } = require("./backend/capacity.cjs");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "chronicle",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
app.setName("Dota Chronicle");
const legacyData = path.join(app.getPath("appData"), "Dota Chronicle");
app.setPath(
  "userData",
  dataDirectory({
    packaged: app.isPackaged,
    executable: process.execPath,
    appData: app.getPath("appData"),
    override: process.env.CHRONICLE_DATA_DIR,
  }),
);
const acquired = app.requestSingleInstanceLock();
if (!acquired) app.quit();
let win,
  library,
  media,
  history,
  data,
  busy = false,
  owner;
async function currentOwner() {
  return (owner ||= await recovery.ownership(data, w));
}
function diskResource(rel) {
  const root = app.getAppPath();
  return path.join(root.endsWith(".asar") ? root + ".unpacked" : root, rel);
}
async function sessions() {
  const base = path.join(data, "sessions");
  await f.noLinks(base);
  await fs.mkdir(base, { recursive: true });
  const rows = [];
  for (const d of await fs.readdir(base, { withFileTypes: true }))
    if (d.isDirectory() && /^[a-f0-9-]{36}$/.test(d.name))
      try {
        await f.noLinks(path.join(base, d.name, "state.json"));
        const state = await f.readJson(path.join(base, d.name, "state.json"));
        if (state?.id === d.name) rows.push(state);
      } catch {}
  return rows.sort((a, b) => b.createdUtc.localeCompare(a.createdUtc));
}
async function guardian(folder, recover = false) {
  const log = await fs.open(path.join(folder, "guardian.log"), "a");
  const child = spawn(
    process.execPath,
    [
      diskResource("src/backend/worker.cjs"),
      folder,
      ...(recover ? ["--recover"] : []),
    ],
    {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  child.on("error", async (error) => {
    try {
      const pending = await f.readJson(path.join(folder, "state.json"));
      if (
        pending.stage === "queued" ||
        (recover && pending.stage === "restoring")
      )
        await f.writeJson(path.join(folder, "state.json"), {
          ...pending,
          stage: recover ? "recovery-required" : "failed",
          error: "无法创建启动守护进程：" + error.message,
          finishedUtc: new Date().toISOString(),
        });
    } catch {}
  });
  child.on("exit", async (code) => {
    try {
      const pending = await f.readJson(path.join(folder, "state.json"));
      if (
        pending.stage === "queued" ||
        (recover && pending.stage === "restoring")
      )
        await f.writeJson(path.join(folder, "state.json"), {
          ...pending,
          stage: recover ? "recovery-required" : "failed",
          error: "启动守护进程提前退出（" + code + "），请打开日志检查。",
          finishedUtc: new Date().toISOString(),
        });
    } catch {}
  });
  child.unref();
  await log.close();
}
async function recoverSession(state, peers = []) {
  const folder = path.join(data, "sessions", state.id);
  const ownership = await currentOwner().catch(() => null);
  const decision = recovery.plan(state, folder, ownership);
  if (!decision.allowed) {
    const completed = await recovery.acknowledgeRecoveredCopy(
      state,
      folder,
      ownership,
      w,
      peers,
    );
    await f.writeJson(
      path.join(folder, "state.json"),
      completed || recovery.blockedState(state, decision),
    );
    return completed ? "completed" : "blocked";
  }
  if (
    state.worker &&
    w.sameProcess(await w.identity(state.worker.pid), state.worker)
  )
    return "running";
  library.entry(state.entry.id);
  await f.writeJson(path.join(folder, "state.json"), {
    ...state,
    stage: "restoring",
  });
  await guardian(folder, true);
  return "recovering";
}
async function recover() {
  const prior = await sessions();
  for (const state of prior)
    if (recovery.activeStages.includes(state.stage)) {
      try {
        await recoverSession(state, prior);
      } catch (error) {
        await f.writeJson(path.join(data, "sessions", state.id, "state.json"), {
          ...state,
          stage: "recovery-required",
          cleanupError: error.message,
          recoveryGuidance:
            "保留旧 data 与客户端暂存文件。请检查会话日志后重试恢复，或导出绑定到全新 data 后继续使用。",
        });
      }
    }
}
function publicSession(s) {
  return {
    id: s.id,
    version: s.entry.id,
    mode: s.mode,
    joinMode: s.mode === "join" ? s.joinMode || "bots" : undefined,
    type: s.type,
    stage: s.stage,
    pid: s.game?.pid || null,
    host: s.host,
    room: s.room,
    join: s.join,
    error: [s.error, s.cleanupError].filter(Boolean).join("；"),
    recoveryGuidance: s.recoveryGuidance || "",
    skillEditorPhase: ["skills", "aghanim1-skills"].includes(s.mode)
      ? s.skillEditorPhase || ""
      : undefined,
    skillEditorError: ["skills", "aghanim1-skills"].includes(s.mode)
      ? s.skillEditorError || ""
      : undefined,
    createdUtc: s.createdUtc,
  };
}
async function launch(input, type = "client") {
  if (busy) throw Error("上一项启动任务正在处理，请稍候");
  busy = true;
  try {
    if (!input || typeof input !== "object") throw Error("启动参数无效");
    await library.load();
    const entry = library.entry(input.id),
      mode = input.mode || "menu",
      root = library.config.roots[entry.id];
    assertSkillEditorMode(entry, mode, {
      host: input.host === true || type === "dedicated",
      type,
    });
    const joinMode =
      mode === "join"
        ? input.joinMode === undefined
          ? "bots"
          : input.joinMode
        : undefined;
    const runtime = await inspect(
      entry,
      root,
      mode,
      library.config.packages,
      joinMode,
    );
    const launchOptions = await library.launchOptionsFor(
      entry.id,
      runtime.root,
    );
    const host = input.host === true || type === "dedicated",
      join = mode === "join" ? serverAddress(input.server) : undefined;
    let room = roomOptions(input.room || library.config.room);
    if (host && room.bind && !networks().some((n) => n.address === room.bind))
      throw Error(
        "房主监听地址已失效。请在本地房间 → 语言与网络设置重新选择监听网卡并保存。",
      );
    if (!entry.playable && (host || type !== "client" || mode !== "menu"))
      throw Error("此构建仅支持主菜单，不能比赛、开房或连接服务器");
    if (entry.prototype && host) throw Error("原型版只开放已验证的单人入口");
    const prior = await sessions();
    const active = prior.filter((s) =>
      [
        "queued",
        "starting",
        "loading",
        "running",
        "stopping",
        "restoring",
        "recovery-required",
      ].includes(s.stage),
    );
    if (
      active.some((s) =>
        type === "dedicated" ? s.type === "dedicated" : s.type !== "dedicated",
      )
    )
      throw Error(
        active.some((s) => s.stage === "recovery-required")
          ? "旧会话需要恢复。请在右侧会话中重试恢复、按原位置恢复指引操作，或导出绑定到全新 data。"
          : "已有对应启动任务正在运行，请先结束它",
      );
    if (host && active.some((s) => s.host && s.room.port === room.port))
      throw Error("该端口正在被本启动器的房间使用");
    if (type === "dedicated" && (entry.id !== "7.32" || mode !== "bots"))
      throw Error("当前专服适配器只覆盖 7.32 普通比赛");
    if (type === "dedicated") {
      const disk = await w.diskSpace(runtime.root);
      assertRuntimeCapacity(disk, await loadPolicy(data));
    }
    const ownership = await currentOwner();
    const id = crypto.randomUUID(),
      folder = path.join(data, "sessions", id);
    await fs.mkdir(folder, { recursive: true });
    const state = {
      id,
      ownership,
      entry,
      root: runtime.root,
      mode,
      joinMode,
      type,
      host,
      room,
      join,
      packages: library.config.packages,
      language: launchOptions.language,
      serverResources: diskResource("resources/server"),
      createdUtc: new Date().toISOString(),
      stage: "queued",
    };
    await f.writeJson(path.join(folder, "state.json"), state);
    await guardian(folder);
    library.config.room = room;
    await library.save();
    return publicSession(state);
  } finally {
    busy = false;
  }
}
function register(name, handler) {
  ipcMain.handle("chronicle:" + name, async (event, input) => {
    try {
      if (
        event.sender !== win.webContents ||
        event.senderFrame?.url !== "chronicle://app/index.html"
      )
        throw Error("不可信的调用来源");
      return { ok: true, value: await handler(input) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}
app
  .whenReady()
  .then(async () => {
    if (!acquired) return;
    data = app.getPath("userData");
    await prepareStorage(
      data,
      process.env.CHRONICLE_DATA_DIR ? null : legacyData,
    );
    library = await new Library(
      await f.readJson(path.join(__dirname, "../resources/catalog.json")),
      data,
      await f.readJson(
        path.join(__dirname, "../resources/client-sources.json"),
      ),
    ).load();
    media = await new MediaLibrary(data, library.catalog).load();
    history = await f.readJson(
      path.join(__dirname, "../resources/history.json"),
    );
    const uiRoot = path.join(__dirname, "ui");
    protocol.handle("chronicle", (request) => {
      const u = new URL(request.url);
      if (u.hostname !== "app")
        return new Response("Not found", { status: 404 });
      if (u.pathname.startsWith("/media/")) return media.response(request);
      let target;
      try {
        target = f.inside(
          uiRoot,
          decodeURIComponent(u.pathname).slice(1) || "index.html",
        );
      } catch {
        return new Response("Not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(target).href);
    });
    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 1080,
      minHeight: 740,
      backgroundColor: "#101317",
      title: "Dota Chronicle · DOTA 2 编年馆",
      icon: path.join(__dirname, "../resources/icon.ico"),
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.session.setPermissionRequestHandler(
      (wc, permission, cb, details) =>
        cb(
          permission === "fullscreen" &&
            wc === win.webContents &&
            wc.getURL() === "chronicle://app/index.html" &&
            details.isMainFrame === true &&
            details.requestingUrl === "chronicle://app/index.html",
        ),
    );
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (_details, cb) => cb({ cancel: true }),
    );
    register("snapshot", async () => {
      await media.load();
      const snapshot = await media.hydrate(await library.snapshot());
      snapshot.entries = orderClients(history, snapshot.entries);
      return {
        ...snapshot,
        launcherVersion: app.getVersion(),
        history: hydrateHistory(history, snapshot.entries, snapshot.collection),
        sessions: (await sessions()).slice(0, 30).map(publicSession),
      };
    });
    register("status", async () => ({
      sessions: (await sessions()).slice(0, 30).map(publicSession),
      configRevision: await library.configRevision(),
    }));
    register("copy", async (input) => {
      if (typeof input !== "string" || input.length > 4000)
        throw Error("复制内容无效");
      clipboard.writeText(input);
      return true;
    });
    register("importMedia", async (input) => {
      await media.load();
      media.assertWritable();
      media.validateTarget(input?.id, input?.kind);
      const bound = (await library.snapshot()).entries.some(
        (e) =>
          (e.id === input.id || e.events.some((v) => v.id === input.id)) &&
          (e.installed || e.archived),
      );
      if (!bound) throw Error("请先绑定对应客户端或历史档案");
      const result = await dialog.showOpenDialog(win, {
        title: "添加对应档案的本地素材",
        properties: ["openFile"],
        filters: [
          {
            name: input.kind === "video" ? "WebM 视频" : "截图 / 封面",
            extensions:
              input.kind === "video" ? ["webm"] : ["png", "jpg", "jpeg"],
          },
        ],
      });
      if (result.canceled) return null;
      return media.importFile(input.id, input.kind, result.filePaths[0]);
    });
    register("bind", async (input) => {
      const e = library.entry(input?.id);
      if (!e.playable && !e.archiveExe) throw Error("档案不完整，暂不支持绑定");
      const r = await dialog.showOpenDialog(win, {
        title: "选择 " + e.version + " 的客户端根目录",
        properties: ["openDirectory"],
      });
      if (r.canceled) return null;
      return library.bind(e.id, r.filePaths[0]);
    });
    register("scan", async () => {
      const r = await dialog.showOpenDialog(win, {
        title: "选择存放历史客户端的上级目录",
        properties: ["openDirectory"],
      });
      if (r.canceled) return [];
      return library.scan(r.filePaths[0]);
    });
    register("bindArchives", async () => {
      const r = await dialog.showOpenDialog(win, {
        title: "选择含 archive-index.json 的历史版本归档文件夹",
        properties: ["openDirectory"],
      });
      if (r.canceled) return null;
      return library.bindArchives(r.filePaths[0]);
    });
    register("package", async (input) => {
      const r = await dialog.showOpenDialog(win, {
        title: "绑定对应的原始游廊 VPK",
        filters: [{ name: "Valve Pak", extensions: ["vpk"] }],
        properties: ["openFile"],
      });
      if (r.canceled) return null;
      await library.package(input?.id, r.filePaths[0]);
      return true;
    });
    register("prepare", async (input) => {
      if (busy) throw Error("正在处理启动任务");
      busy = true;
      try {
        const e = library.entry(input?.id),
          event = e.events.find(
            (v) => v.id === input.mode && v.kind === "compat",
          );
        if (!event) throw Error("没有此活动的兼容方案");
        if (
          (await w.processes()).some(
            (p) => !p.ExecutablePath?.toLowerCase().endsWith("steam.exe"),
          )
        )
          throw Error("请先关闭游戏和专服，再准备兼容入口");
        const runtime = await inspect(e, library.config.roots[e.id]);
        return require("./backend/compat.cjs").prepare(
          event.id,
          runtime.root,
          diskResource("resources/compat"),
          data,
        );
      } finally {
        busy = false;
      }
    });
    register("launch", (input) => launch(input));
    register("saveLaunchOptions", (input) => library.setLaunchOptions(input));
    register("host", (input) =>
      launch(
        { ...input, host: true },
        input?.id === "7.32" && (input.mode || "bots") === "bots"
          ? "dedicated"
          : "client",
      ),
    );
    register("join", (input) =>
      launch({ ...input, mode: "join", host: false }),
    );
    register("saveRoom", async (input) => {
      await library.load();
      const room = roomOptions(input);
      if (room.bind && !networks().some((n) => n.address === room.bind))
        throw Error("监听网卡已失效，请重新选择本机网卡或全部本机网卡后保存");
      library.config.room = room;
      await library.save();
      return library.config.room;
    });
    register("stop", async (input) => {
      const s = (await sessions()).find((s) => s.id === input?.id);
      if (!s || !["starting", "loading", "running"].includes(s.stage))
        throw Error("没有可结束的本程序会话");
      const decision = recovery.plan(
        s,
        path.join(data, "sessions", s.id),
        await currentOwner(),
      );
      if (!decision.allowed)
        throw Error(decision.reason + "。" + decision.guidance);
      if (!s.worker || !w.sameProcess(await w.identity(s.worker.pid), s.worker))
        throw Error("守护进程未运行，请重启启动器以恢复会话");
      await fs.writeFile(
        path.join(data, "sessions", s.id, "stop.request"),
        "stop\n",
        { flag: "wx" },
      );
      return true;
    });
    register("recover", async (input) => {
      if (busy) throw Error("正在处理启动任务，请稍候");
      busy = true;
      try {
        const prior = await sessions();
        const s = prior.find((s) => s.id === input?.id);
        if (!s || s.stage !== "recovery-required")
          throw Error("没有可重试恢复的会话");
        return await recoverSession(s, prior);
      } finally {
        busy = false;
      }
    });
    register("exportBindings", async () => {
      await library.load();
      const r = await dialog.showOpenDialog(win, {
        title: "选择保存全新 data 的父目录（旧会话与租约证据保留原处）",
        properties: ["openDirectory", "createDirectory"],
      });
      if (r.canceled) return null;
      const result = await exportBindings(data, r.filePaths[0], library.config);
      const instructions = process.env.CHRONICLE_DATA_DIR
        ? `退出启动器，将 CHRONICLE_DATA_DIR 指向 ${result}，然后重新打开。旧 data 和原位置租约必须保留供恢复。`
        : app.isPackaged
          ? `退出启动器，把当前 ${data} 改名备份保留；将 ${result} 放到 EXE 旁并命名为 data，然后重新打开。旧 data 和原位置租约必须保留供恢复。`
          : `退出启动器，把当前 ${data} 改名备份保留；将 ${result} 放到同一位置并命名为 Dota Chronicle，然后重新打开。旧 data 和原位置租约必须保留供恢复。`;
      const details =
        instructions +
        "\n导出不会恢复旧客户端或 Steam 注册表租约。复用旧客户端前必须在原位置完成恢复；其他电脑请重新绑定干净客户端、地图与外置媒体，并重新选择监听网卡。";
      await fs.writeFile(
        path.join(result, "RECOVERY-INSTRUCTIONS.txt"),
        details + "\n",
        { flag: "wx" },
      );
      const openError = await shell.openPath(result);
      await dialog.showMessageBox(win, {
        type: "info",
        title: "绑定已导出",
        message: "全新 data 已准备",
        detail:
          details + (openError ? "\n文件夹未能自动打开：" + openError : ""),
      });
      return result;
    });
    register("fillBots", async (input) => {
      const s = (await sessions()).find((s) => s.id === input?.id);
      if (
        !s ||
        s.type !== "dedicated" ||
        s.stage !== "running" ||
        !s.game ||
        !w.sameProcess(await w.identity(s.game.pid), s.game)
      )
        throw Error("本程序专服尚未就绪");
      const decision = recovery.plan(
        s,
        path.join(data, "sessions", s.id),
        await currentOwner(),
      );
      if (!decision.allowed) throw Error(decision.reason);
      return w.fillServerBots(
        s.root,
        path.join(data, "sessions", s.id, "server"),
        s.game,
      );
    });
    register("openFolder", async (input) => {
      let target;
      if (input?.kind === "client")
        target = library.config.roots[library.entry(input.id).id];
      else if (input?.kind === "archive")
        target = await archiveFolder(library.config.archiveRoot, input.id);
      else if (input?.kind === "session") {
        const s = (await sessions()).find((s) => s.id === input.id);
        if (!s) throw Error("未知会话");
        target = path.join(data, "sessions", s.id);
      } else target = data;
      if (!target) throw Error("尚未绑定文件夹");
      const err = await shell.openPath(target);
      if (err) throw Error(err);
      return true;
    });
    app.on("second-instance", () => {
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
    await recover();
    await win.loadURL("chronicle://app/index.html");
    win.show();
  })
  .catch((e) => {
    dialog.showErrorBox("Dota Chronicle 无法启动", e.message);
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
