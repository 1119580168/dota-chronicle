const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs/promises");
const { hash, exists, inside, noLinks } = require("./files.cjs");
const { languageCode } = require("./languages.cjs");
const {
  assertEventEnabled,
  assertSkillEditorMode,
  skillEditorProfile,
  launchEvent,
  allowsLabyrinthSkillEditor,
} = require("./event-catalog.cjs");
function roomOptions(r = {}) {
  const port = Number(r.port ?? 30323),
    password = String(r.password ?? "chronicle-room"),
    bind = String(r.bind || "");
  if (!Number.isInteger(port) || port < 1024 || port > 65534)
    throw Error("端口必须为 1024–65534 的整数");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(password))
    throw Error("房间密码只能包含 1–64 位字母、数字、下划线或短横线");
  if (bind && net.isIP(bind) !== 4) throw Error("请选择本机 IPv4 地址");
  return { port, password, bind, internet: r.internet === true };
}
function serverAddress(v) {
  if (
    typeof v !== "string" ||
    v.length > 253 ||
    !/^[a-zA-Z0-9.-]+$/.test(v) ||
    v.startsWith("-") ||
    v.includes("..")
  )
    throw Error("请输入有效 IP 或主机名");
  if (/^[0-9.]+$/.test(v) && net.isIP(v) !== 4) throw Error("IPv4 地址不正确");
  return v;
}
function joinEvent(entry, joinMode = "bots") {
  if (joinMode === "bots") return undefined;
  const event =
    typeof joinMode === "string"
      ? entry.events.find((event) => event.id === joinMode)
      : undefined;
  if (!event) throw Error("加入的地图不属于这个版本");
  return event;
}
async function inspectPackage(file, expectedSha) {
  if (typeof file !== "string" || !path.isAbsolute(file))
    throw Error("游廊包必须使用实际绝对路径");
  await noLinks(file);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw Error("请选择普通 VPK 地图文件，不能绑定文件夹");
  if ((await hash(file)) !== expectedSha)
    throw Error("游廊包指纹不同，请使用已验证的停更版本");
  return fs.realpath(file);
}
async function inspect(
  entry,
  root,
  mode = "menu",
  packages = {},
  joinMode = "bots",
) {
  assertSkillEditorMode(entry, mode);
  if (
    !entry.playable &&
    !(entry.menuOnly === true && entry.archiveExe && mode === "menu")
  )
    throw Error("该历史包缺少比赛组件，仅支持进入主菜单");
  if (!root || !path.isAbsolute(root))
    throw Error("请先绑定此版本的客户端文件夹");
  await noLinks(root);
  root = await require("node:fs/promises").realpath(root);
  const exe = inside(root, entry.playable ? entry.exe : entry.archiveExe),
    inf = inside(root, entry.steamInf);
  if (!entry.playable) {
    await noLinks(exe);
    await noLinks(inf);
  }
  if (!(await exists(exe)) || !(await exists(inf)))
    throw Error("未找到可执行程序或 steam.inf，请选择客户端根目录");
  if ((await hash(inf)) !== entry.sha)
    throw Error("客户端构建与此历史节点不匹配，已阻止启动");
  if (
    !["menu", "bots", "join", "skills"].includes(mode) &&
    !launchEvent(entry, mode)
  )
    throw Error("地图不属于这个版本");
  const event =
    mode === "join" ? joinEvent(entry, joinMode) : launchEvent(entry, mode);
  let packageFile;
  if (event) {
    assertEventEnabled(event);
    if (event.category === "community") {
      const file = packages[event.id];
      if (!file) throw Error("请在库管理中绑定对应的原始 VPK 地图包");
      packageFile = await inspectPackage(file, event.packageSha);
    } else {
      const rel =
        (entry.source2 ? "game/dota_addons/" : "dota/addons/") +
        event.addon +
        "/maps/" +
        event.map +
        (entry.source2 ? ".vpk" : ".bsp");
      if (!(await exists(inside(root, rel))))
        throw Error("客户端缺少活动地图：" + event.map);
    }
    for (const req of event.requirements || [])
      if (
        !(await exists(inside(root, req.path))) ||
        (await hash(inside(root, req.path))) !== req.sha
      )
        throw Error(
          "活动兼容文件未准备或已变化：" +
            req.path +
            "。请参阅离线操作说明中的兼容入口。",
        );
  }
  return { root, exe, event, packageFile };
}
function buildClientCfg({ mode, event, host, room, entry, type }) {
  assertSkillEditorMode(entry, mode, { host, type });
  if (mode === "skills" && event)
    throw Error("技能编辑器不能挂载比赛或游廊地图入口");
  if (mode === "aghanim1-skills" && !allowsLabyrinthSkillEditor(entry, event))
    throw Error("迷宫技能编辑器必须使用已核验的官方迷宫地图");
  assertEventEnabled(event);
  const lines = [
    "// Dota Chronicle local entry; original game balance unchanged.",
    "con_enable 1",
    "bind F8 toggleconsole",
    "hideconsole",
  ];
  if (skillEditorProfile(entry, mode)) lines.push("sv_cheats 1");
  if (event?.category === "community" && mode !== "join") {
    if (event.requiresCheats === true && mode === event.id)
      lines.push("sv_cheats 1");
    lines.push(
      "sv_lan " + (host && room.internet ? "0" : "1"),
      "map " +
        event.map +
        " gamemode=15 customgamemode=" +
        event.workshopId +
        " difficulty=0 nomapvalidation=1",
    );
  }
  return lines.join("\n") + "\n";
}
function buildArgs(entry, mode, runtime, options) {
  assertSkillEditorMode(entry, mode, options);
  if (
    !entry.playable &&
    !(entry.menuOnly === true && mode === "menu" && !options.host)
  )
    throw Error("此构建仅支持主菜单，不能比赛、开房或连接服务器");
  const { root, event } = runtime,
    { id, log, host, room, join, cfgName, packages, prototypePassword } =
      options;
  if (mode === "skills" && event)
    throw Error("技能编辑器不能挂载比赛或游廊地图入口");
  if (mode === "aghanim1-skills" && !allowsLabyrinthSkillEditor(entry, event))
    throw Error("迷宫技能编辑器必须使用已核验的官方迷宫地图");
  assertEventEnabled(event);
  assertEventEnabled(
    mode === "join"
      ? joinEvent(entry, options.joinMode)
      : launchEvent(entry, mode),
  );
  if (mode === "join" && joinEvent(entry, options.joinMode)?.id !== event?.id)
    throw Error("加入的目标地图尚未通过核验");
  const game = path.join(root, entry.source2 ? "game/dota" : "dota");
  const port = host ? room.port : entry.prototype ? 27110 : 27491;
  const bind = host ? room.bind || "0.0.0.0" : "127.0.0.1";
  const args = [
    "-game",
    game,
    "-windowed",
    "-w",
    "1280",
    "-h",
    "720",
    "-novid",
    "-nojoy",
    "-insecure",
    "-console",
    "-condebug",
    "-language",
    languageCode(options.language),
    "-ip",
    bind,
    "-port",
    String(port),
    "-con_logfile",
    log,
    "+con_enable",
    "1",
    "+sv_lan",
    host && room.internet ? "0" : "1",
    "+exec",
    cfgName,
  ];
  if (skillEditorProfile(entry, mode) && !options.skillBootstrap)
    throw Error("技能编辑器缺少本机会话初始化参数");
  if (options.skillBootstrap) {
    const control = options.skillBootstrap;
    if (
      !skillEditorProfile(entry, mode) ||
      host ||
      !entry.source2 ||
      options.hostBootstrap
    )
      throw Error("此入口不允许技能编辑器初始化");
    if (
      !Number.isInteger(control.port) ||
      control.port < 1024 ||
      control.port > 65534 ||
      !/^[a-f0-9]{64}$/.test(control.password)
    )
      throw Error("技能编辑器初始化参数无效");
    args.push(
      "-vconsole",
      "-netconport",
      String(control.port),
      "-netconpassword",
      control.password,
    );
  }
  if (options.hostBootstrap) {
    const control = options.hostBootstrap;
    if (
      !host ||
      mode !== "bots" ||
      entry.prototype ||
      entry.listenHostBootstrap !== true
    )
      throw Error("此入口不允许房主入队初始化");
    if (
      !Number.isInteger(control.port) ||
      control.port < 1024 ||
      control.port > 65534 ||
      !/^[a-f0-9]{64}$/.test(control.password)
    )
      throw Error("房主初始化参数无效");
    if (entry.source2) args.push("-vconsole");
    args.push(
      "-netconport",
      String(control.port),
      "-netconpassword",
      control.password,
    );
  }
  if (entry.source2)
    args.push(
      "-allow_no_lobby_connect",
      "+dev_block_gc_hello",
      "1",
      "+dota_quit_after_game",
      "0",
    );
  if (!entry.prototype)
    args.push(
      "+dota_surrender_on_disconnect",
      "0",
      "+sv_hibernate_when_empty",
      "0",
    );
  if (host) args.push("+sv_password", room.password);
  if (event?.category === "community")
    args.unshift("-addon_path", runtime.packageFile || packages[event.id]);
  if (mode === "join")
    args.push(
      "+password",
      room.password,
      "+connect",
      serverAddress(join) + ":" + room.port,
    );
  else if (entry.prototype && mode === "bots")
    args.push(
      "-netconport",
      String(port + 1),
      "-netconpassword",
      prototypePassword,
      "+map",
      "dota",
    );
  else if (event) {
    if (entry.source2) args.push("+dota_idle_time", "86400");
    // The 2020 dashboard must finish loading before mounting Aghanim: mounting
    // it through a startup +command races the TI10 front-page layout loader.
    if (
      event.category !== "community" &&
      entry.source2 &&
      mode !== "aghanim1-skills"
    )
      args.push("+dota_launch_custom_game", event.addon, event.map);
    else if (event.category !== "community" && !entry.source2)
      args.push(
        "+dota_local_addon_enable",
        "1",
        "+dota_local_addon_game",
        event.addon,
        "+dota_local_addon_map",
        event.map,
        "+dota_local_custom_enable",
        "1",
        "+dota_local_custom_game",
        event.addon,
        "+dota_local_custom_map",
        event.map,
        "+dota_force_gamemode",
        "15",
        "+update_addon_paths",
        "+dota_wait_for_players_to_load",
        "0",
        "+dota_wait_for_players_to_load_timeout",
        "10",
        "+map",
        event.map,
      );
  } else if (mode === "bots") {
    args.push("+dota_force_gamemode", "1");
    if (!host)
      args.push(
        "+dota_bot_practice_difficulty",
        "1",
        "+dota_bot_practice_team",
        "0",
        "+dota_bot_practice_start",
        "1",
      );
    args.push("+map", "dota");
  }
  return args;
}
module.exports = {
  roomOptions,
  serverAddress,
  inspectPackage,
  inspect,
  buildClientCfg,
  buildArgs,
};
