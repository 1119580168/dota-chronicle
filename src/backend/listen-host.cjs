const net = require("node:net");

const MAX_REPLY_BYTES = 64 * 1024;
const IO_TIMEOUT_MS = 2000;
const GUARD_TIMEOUT_MS = 10000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function needsHostBootstrap(state) {
  return (
    state?.type === "client" &&
    state.host === true &&
    state.mode === "bots" &&
    !state.entry?.prototype &&
    state.entry?.listenHostBootstrap === true
  );
}

function plainText(text) {
  // Native netcon uses telnet framing. Do not reply to negotiations or expose
  // player names/Steam identities; only inspect the bounded ASCII status fields.
  return text
    .replace(/\xff\xfa[\s\S]*?(?:\xff\xf0|$)/g, "")
    .replace(/\xff[\xfb-\xfe][\s\S]/g, "")
    .replace(/\xff[\xf0-\xfa\xff]/g, "");
}

function parseStatus(text, source2) {
  if (typeof text !== "string" || text.length > MAX_REPLY_BYTES)
    throw Error("本地控制回复无效或超过安全上限");
  if (typeof source2 !== "boolean") throw Error("本地开服引擎参数无效");
  text = plainText(text);
  const players =
    /^\s*players\s*:\s*(\d+)\s+humans?\s*,\s*(\d+)\s+bots?\b/im.exec(text);
  const humans = players ? Number(players[1]) : null,
    bots = players ? Number(players[2]) : null;
  const phaseName = /^\s*gamestate\s*:\s*(DOTA_GAMERULES_STATE_[A-Z_]+)\b/im
    .exec(text)?.[1]
    ?.toUpperCase();
  const phase =
    {
      DOTA_GAMERULES_STATE_HERO_SELECTION: "hero-selection",
      DOTA_GAMERULES_STATE_PRE_GAME: "pre-game",
      DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: "in-progress",
      DOTA_GAMERULES_STATE_POST_GAME: "post-game",
    }[phaseName] || "unknown";
  const complete = /^\s*#end\s*$/im.test(text);
  const mapReady = source2
    ? /^\s*server\s*:\s*running\b/im.test(text) &&
      /^\s*@\s*current\s*:\s*game\s*$/im.test(text) &&
      /^\s*loaded spawngroup\s*\([^\r\n)]*\)\s*:\s*SV\s*:\s*\[\s*\d+\s*:\s*dota\s*\|/im.test(
        text,
      )
    : /^\s*map\s*:\s*dota(?:\s|$)/im.test(text);
  const localPlayerActive = source2
    ? /^\s*client\s*:\s*connected\s*\[loopback\]/im.test(text) &&
      /^\s*\d+\s+\d+:\d+(?::\d+)?\s+\d+\s+\d+\s+active\s+\d+\s+.+$/im.test(text)
    : /^\s*#\s*\d+\s+.+\sactive\s+\d+\s+loopback\s*$/im.test(text);
  return {
    complete,
    mapReady,
    localPlayerActive,
    humans,
    bots,
    phase,
    ready:
      complete &&
      mapReady &&
      localPlayerActive &&
      Number.isSafeInteger(humans) &&
      humans >= 1 &&
      bots === 0 &&
      phase === "hero-selection",
  };
}

async function waitAndJoin({
  port,
  password,
  source2,
  isOwned,
  isStopping,
  onPhase = async () => {},
  timeoutMs = 90000,
  connect = (options) => net.connect(options),
  sleep = delay,
}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("本地控制端口必须为 1024–65535 的整数");
  if (typeof password !== "string" || !/^[a-f\d]{48,256}$/i.test(password))
    throw Error("本地控制口令必须是至少 48 位的十六进制随机值");
  if (typeof source2 !== "boolean") throw Error("本地开服引擎参数无效");
  if (
    ![isOwned, isStopping, onPhase, connect, sleep].every(
      (fn) => typeof fn === "function",
    ) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 180000
  )
    throw Error("本地开服初始化参数无效");

  const deadline = Date.now() + timeoutMs;
  let socket,
    connectionEstablished = false,
    buffer = "",
    replyBytes = 0,
    lastDataAt = 0,
    socketError,
    lastPhase,
    readyStatus;

  const timeoutError = () =>
    Error(
      lastPhase === "connecting"
        ? "等待本地控制端口超时，请结束房间后重新开服"
        : "等待本地地图与选人阶段超时，请结束房间后重新开服",
    );
  const cancelled = () =>
    Object.assign(Error("房间正在停止，已取消房主初始化"), {
      code: "LISTEN_HOST_CANCELLED",
    });
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw timeoutError();
    return ms;
  };
  const bounded = async (operation, limit, message) => {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error(message)),
            Math.min(limit, remaining()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const guard = async () => {
    remaining();
    const stopping = () =>
      bounded(
        Promise.resolve().then(isStopping),
        GUARD_TIMEOUT_MS,
        "检查房间停止请求超时",
      );
    if (await stopping()) throw cancelled();
    if (
      !(await bounded(
        Promise.resolve().then(() =>
          isOwned({ connected: connectionEstablished }),
        ),
        GUARD_TIMEOUT_MS,
        "确认本程序游戏进程身份超时",
      ))
    ) {
      if (await stopping()) throw cancelled();
      throw Error("游戏进程已退出或不再属于本程序，已停止房主初始化");
    }
    if (await stopping()) throw cancelled();
  };
  const phase = async (value) => {
    if (lastPhase === value) return;
    await bounded(
      Promise.resolve().then(() => onPhase(value)),
      IO_TIMEOUT_MS,
      "记录房主初始化阶段超时",
    );
    lastPhase = value;
  };
  const pause = (ms) =>
    bounded(
      Promise.resolve().then(() => sleep(Math.min(ms, remaining()))),
      Math.min(ms + 100, IO_TIMEOUT_MS),
      "等待本地地图与选人阶段超时，请结束房间后重新开服",
    );
  const checkReply = () => {
    if (socketError) throw socketError;
    const text = plainText(buffer);
    if (
      /^\s*(?:bad\s+password|not\s+authenticated|authentication\s+failed|password\s+incorrect)\b/im.test(
        text,
      )
    )
      throw Error("本地控制口令认证失败，请结束房间后重新开服");
    return text;
  };

  async function open() {
    await phase("connecting");
    for (;;) {
      await guard();
      socketError = undefined;
      buffer = "";
      replyBytes = 0;
      let connected = false;
      try {
        const candidate = connect({ host: "127.0.0.1", port });
        socket = candidate;
        candidate.on("data", (chunk) => {
          if (socket !== candidate) return;
          replyBytes += chunk.length;
          if (replyBytes > MAX_REPLY_BYTES) {
            socketError = Error("本地控制回复超过安全上限");
            socket.destroy();
            return;
          }
          buffer += chunk.toString("latin1");
          lastDataAt = Date.now();
        });
        candidate.on("error", () => {
          if (socket !== candidate) return;
          socketError ||= Error("本地控制连接发生错误，请结束房间后重新开服");
        });
        candidate.on("close", () => {
          if (socket !== candidate) return;
          socketError ||= Error("本地控制连接已关闭，请结束房间后重新开服");
        });
        await bounded(
          new Promise((resolve, reject) => {
            candidate.once("connect", resolve);
            candidate.once("error", reject);
            candidate.once("close", () => reject(Error("closed")));
          }),
          IO_TIMEOUT_MS,
          "连接本地控制端口超时",
        );
        connected = true;
        // Waiting for a native listener is allowed only before a connection.
        // Every subsequent command needs a positively identified listener PID.
        connectionEstablished = true;
        checkReply();
        return;
      } catch (error) {
        socket?.destroy();
        if (connected) throw error;
        // The owned client can start its loopback control port after loading.
        // Never retry a successfully connected socket after a protocol failure.
        await pause(200);
      }
    }
  }

  async function send(command, status = false) {
    await guard();
    checkReply();
    buffer = "";
    replyBytes = 0;
    lastDataAt = 0;
    const start = Date.now(),
      replyDeadline = Math.min(deadline, start + IO_TIMEOUT_MS);
    await bounded(
      new Promise((resolve, reject) => {
        socket.write(command + "\n", (error) =>
          error ? reject(Error("发送本地控制命令失败")) : resolve(),
        );
      }),
      IO_TIMEOUT_MS,
      "发送本地控制命令超时",
    );
    for (;;) {
      const text = checkReply(),
        now = Date.now();
      if (status && /^\s*#end\s*$/im.test(text)) return text;
      if (
        !status &&
        ((text && now - lastDataAt >= 40) || (!text && now - start >= 120))
      )
        return text;
      if (now >= replyDeadline) {
        if (status) return text;
        throw Error("本地控制命令回复超时");
      }
      await pause(20);
    }
  }

  try {
    await open();
    await send("PASS " + password);
    await phase("waiting-map");
    for (;;) {
      await guard();
      const parsed = parseStatus(await send("status", true), source2);
      if (
        parsed.complete &&
        parsed.mapReady &&
        ["pre-game", "in-progress", "post-game"].includes(parsed.phase)
      )
        throw Error("本地比赛已错过选人阶段，请结束房间后重新开服");
      if (parsed.ready) {
        readyStatus = parsed;
        break;
      }
      await pause(200);
    }
    await phase("joining");
    await send("cmd jointeam good");
    await send("bind F8 toggleconsole");
    await send("hideconsole");
    await send("gameui_hide");
    await guard();
    await phase("ready");
    // Native status has no team field. This records that the command was sent,
    // never a verified team assignment or a playable match.
    return {
      commandSent: true,
      team: "good",
      humans: readyStatus.humans,
      bots: readyStatus.bots,
    };
  } finally {
    socket?.destroy();
  }
}

module.exports = { needsHostBootstrap, parseStatus, waitAndJoin };
