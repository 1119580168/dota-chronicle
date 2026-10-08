const test = require("node:test"),
  assert = require("node:assert/strict"),
  { EventEmitter } = require("node:events"),
  net = require("node:net");
const {
  needsHostBootstrap,
  parseStatus,
  waitAndJoin,
} = require("../src/backend/listen-host.cjs");

const password = "a1".repeat(32);
const source1 = `version : 40/40 5290 insecure
map : dota at: 0 x, -666 y, 1059 z
players : 1 humans, 0 bots (24 max) (not hibernating)
gamestate: DOTA_GAMERULES_STATE_HERO_SELECTION Times: Transition=61.00 Current=37.30
# userid name uniqueid connected ping loss state rate adr
# 2 1 "private-player" STEAM_1:0:999999 00:00 33 0 active 100000 loopback
#end
`;
const source2 = `Server: Running [127.0.0.1:30325]
Client: Connected [loopback] [last packet 0.01 seconds ago]
----- Status -----
@ Current : game
source : slot 0
version : 44
players : 1 humans, 0 bots (0 max) (not hibernating) (unreserved)
loaded spawngroup(1): SV:[1: dota |main lump|mapload]
---------players--------
 id time ping loss state rate name
 1 00:00 0 0 active 80000 'private-player'
GameState: DOTA_GAMERULES_STATE_HERO_SELECTION Times: Transition=61.00 Current=37.30
#end
`;

async function serverFixture(t, respond) {
  const commands = [],
    sockets = new Set();
  let reportClosed;
  const closed = new Promise((resolve) => {
    reportClosed = resolve;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    if (respond?.greeting) socket.write(respond.greeting);
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      reportClosed();
    });
    let input = "",
      authenticated = false;
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const command = input.slice(0, newline).replace(/\r$/, "");
        input = input.slice(newline + 1);
        commands.push(command);
        if (command.startsWith("PASS ")) {
          authenticated = command === "PASS " + password;
          if (respond?.auth === false) authenticated = false;
          socket.write(authenticated ? "Authenticated\n" : "Bad password\n");
          continue;
        }
        if (!authenticated) {
          socket.write("Not authenticated\n");
          continue;
        }
        const response = respond?.(command, commands, socket);
        if (response !== undefined) socket.write(response);
        else if (command !== "status") socket.write("ok\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, commands, closed };
}

function options(fixture, extra = {}) {
  return {
    port: fixture.port,
    password,
    source2: false,
    isOwned: async () => true,
    isStopping: async () => false,
    timeoutMs: 3000,
    ...extra,
  };
}

function assertNoGameplayCommands(commands) {
  for (const command of commands)
    assert.ok(
      command.startsWith("PASS ") ||
        [
          "status",
          "cmd jointeam good",
          "bind F8 toggleconsole",
          "hideconsole",
          "gameui_hide",
        ].includes(command),
      "initializer must never choose heroes, fill Bots, run maps or scripts",
    );
}

test("bootstrap is opt-in and exclusive to ordinary client listen hosts", () => {
  const state = {
    type: "client",
    host: true,
    mode: "bots",
    entry: { listenHostBootstrap: true, prototype: false },
  };
  assert.equal(needsHostBootstrap(state), true);
  for (const change of [
    { type: "dedicated" },
    { host: false },
    { host: 1 },
    { mode: "join" },
    { mode: "menu" },
    { mode: "fixture-rpg" },
    { entry: { listenHostBootstrap: true, prototype: true } },
    { entry: { listenHostBootstrap: false } },
    { entry: { listenHostBootstrap: "true" } },
    { entry: {} },
  ])
    assert.equal(needsHostBootstrap({ ...state, ...change }), false);
  assert.equal(needsHostBootstrap(null), false);
});

test("native Source 1/2 status requires loaded dota, active loopback human and hero selection", () => {
  for (const [text, isSource2] of [
    [source1, false],
    [source2, true],
  ]) {
    const parsed = parseStatus(text, isSource2);
    assert.equal(parsed.ready, true);
    assert.equal(parsed.phase, "hero-selection");
    assert.equal(parsed.humans, 1);
    assert.equal(parsed.bots, 0);
    assert.ok(!JSON.stringify(parsed).includes("private-player"));
    assert.ok(!JSON.stringify(parsed).includes("STEAM_"));
    for (const altered of [
      text.replace("1 humans", "0 humans"),
      text.replace("0 bots", "1 bots"),
      text.replace("dota", "dota_custom"),
      text.replace("loopback", "192.168.1.25"),
      text.replace("active ", "spawning "),
      text.replace("STATE_HERO_SELECTION", "STATE_PRE_GAME"),
      text.replace("STATE_HERO_SELECTION", "STATE_GAME_IN_PROGRESS"),
      text.replace("#end", ""),
    ])
      assert.equal(parseStatus(altered, isSource2).ready, false);
    assert.equal(
      parseStatus(text.replace("1 humans", "2 humans"), isSource2).ready,
      true,
    );
  }
  assert.equal(
    parseStatus(source2.replace("Current : game", "Current : menu"), true)
      .ready,
    false,
  );
  assert.equal(
    parseStatus(source2.replace("Server: Running", "Server: Loading"), true)
      .ready,
    false,
  );
  assert.equal(parseStatus("", false).ready, false);
  assert.throws(() => parseStatus("x".repeat(65537), false), /上限/);
});

test(
  "Source 1 waits for the local active seat, sends join exactly once and cleans up",
  { timeout: 6000 },
  async (t) => {
    let statusCount = 0;
    const f = await serverFixture(t, (command) => {
      if (command === "status") {
        statusCount++;
        return statusCount === 1
          ? source1.replace("active ", "spawning ")
          : source1;
      }
    });
    const phases = [],
      targets = [];
    const result = await waitAndJoin(
      options(f, {
        onPhase: async (phase) => phases.push(phase),
        connect: (target) => {
          targets.push(target);
          return net.connect(target);
        },
      }),
    );
    assert.equal(statusCount, 2);
    assert.equal(f.commands.filter((v) => v === "cmd jointeam good").length, 1);
    assert.ok(
      f.commands.lastIndexOf("status") <
        f.commands.indexOf("cmd jointeam good"),
    );
    assert.deepEqual(targets, [{ host: "127.0.0.1", port: f.port }]);
    assert.deepEqual(phases, ["connecting", "waiting-map", "joining", "ready"]);
    assert.deepEqual(result, {
      commandSent: true,
      team: "good",
      humans: 1,
      bots: 0,
    });
    assert.ok(!("teamVerified" in result));
    assertNoGameplayCommands(f.commands);
    await f.closed;
  },
);

test(
  "Source 2 accepts the complete native status with telnet framing",
  { timeout: 6000 },
  async (t) => {
    const f = await serverFixture(t, (command) => {
      if (command === "status")
        return Buffer.concat([
          Buffer.from([255, 251, 1]),
          Buffer.from(source2),
        ]);
    });
    const result = await waitAndJoin(options(f, { source2: true }));
    assert.equal(result.commandSent, true);
    assert.equal(result.team, "good");
    assert.equal(f.commands.filter((v) => v === "cmd jointeam good").length, 1);
    assertNoGameplayCommands(f.commands);
    await f.closed;
  },
);

test(
  "late events from a failed connection do not corrupt a successful retry",
  { timeout: 6000 },
  async (t) => {
    const f = await serverFixture(t, (command) =>
      command === "status" ? source1 : undefined,
    );
    let attempts = 0,
      listenerOwner = null;
    const expectedPid = 12345,
      ownershipChecks = [];
    const result = await waitAndJoin(
      options(f, {
        isOwned: async ({ connected }) => {
          ownershipChecks.push({ connected, owner: listenerOwner });
          return connected
            ? listenerOwner === expectedPid
            : listenerOwner === null || listenerOwner === expectedPid;
        },
        connect: (target) => {
          attempts++;
          if (attempts > 1) {
            listenerOwner = expectedPid;
            return net.connect(target);
          }
          const rejected = new EventEmitter();
          rejected.destroy = () =>
            setTimeout(() => rejected.emit("close"), 260);
          setImmediate(() => rejected.emit("error", Error("ECONNREFUSED")));
          return rejected;
        },
      }),
    );
    assert.equal(attempts, 2);
    assert.equal(result.commandSent, true);
    assert.ok(
      ownershipChecks.filter((v) => !v.connected && v.owner === null).length >=
        2,
      "missing listener may be waited for before establishing the connection",
    );
    assert.ok(
      ownershipChecks.some((v) => v.connected) &&
        ownershipChecks
          .filter((v) => v.connected)
          .every((v) => v.owner === expectedPid),
    );
    await f.closed;
  },
);

test(
  "an established socket with no matching listener owner cannot receive PASS",
  { timeout: 4000 },
  async (t) => {
    const f = await serverFixture(t, (command) =>
      command === "status" ? source1 : undefined,
    );
    const ownershipChecks = [];
    await assert.rejects(
      waitAndJoin(
        options(f, {
          isOwned: async ({ connected }) => {
            ownershipChecks.push(connected);
            // A missing listener is tolerated for startup retries, but not for
            // an already accepted TCP connection to an unidentified endpoint.
            return !connected;
          },
        }),
      ),
      /不再属于本程序/,
    );
    assert.ok(ownershipChecks.includes(false));
    assert.ok(ownershipChecks.includes(true));
    assert.deepEqual(f.commands, [], "no secret or other command may be sent");
    await f.closed;
  },
);

test(
  "player names cannot masquerade as a protocol authentication failure",
  { timeout: 4000 },
  async (t) => {
    const f = await serverFixture(t, (command) =>
      command === "status"
        ? source1.replace("private-player", "Bad password")
        : undefined,
    );
    const result = await waitAndJoin(options(f));
    assert.equal(result.commandSent, true);
    assert.deepEqual(Object.keys(result).sort(), [
      "bots",
      "commandSent",
      "humans",
      "team",
    ]);
    await f.closed;
  },
);

test(
  "an initial password-required greeting does not reject a valid authenticated session",
  { timeout: 4000 },
  async (t) => {
    const respond = (command) => (command === "status" ? source1 : undefined);
    respond.greeting = "Password required\n";
    const f = await serverFixture(t, respond);
    const result = await waitAndJoin(
      options(f, {
        isOwned: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return true;
        },
      }),
    );
    assert.equal(result.commandSent, true);
    await f.closed;
  },
);

test(
  "wrong authentication aborts before any status or team command",
  { timeout: 4000 },
  async (t) => {
    const respond = () => source1;
    respond.auth = false;
    const f = await serverFixture(t, respond);
    await assert.rejects(waitAndJoin(options(f)), /认证失败/);
    assert.deepEqual(f.commands, ["PASS " + password]);
    await f.closed;
  },
);

test("ownership and stop gates reject before connecting", async () => {
  for (const extra of [
    { isOwned: async () => false },
    { isStopping: async () => true },
  ]) {
    let connections = 0;
    await assert.rejects(
      waitAndJoin(
        options(
          { port: 30325 },
          {
            ...extra,
            connect: () => {
              connections++;
              throw Error("must not connect");
            },
          },
        ),
      ),
      /进程|正在停止/,
    );
    assert.equal(connections, 0);
  }
});

test(
  "loss of ownership or stop after a ready reply prevents team assignment",
  { timeout: 6000 },
  async (t) => {
    for (const condition of ["ownership", "stop"]) {
      let owned = true,
        stopping = false;
      const f = await serverFixture(t, (command) => {
        if (command === "status") {
          if (condition === "ownership") owned = false;
          else stopping = true;
          return source1;
        }
      });
      await assert.rejects(
        waitAndJoin(
          options(f, {
            isOwned: async () => owned,
            isStopping: async () => stopping,
          }),
        ),
        (error) => {
          assert.match(error.message, /进程|正在停止/);
          if (condition === "stop")
            assert.equal(error.code, "LISTEN_HOST_CANCELLED");
          return true;
        },
      );
      assert.ok(!f.commands.includes("cmd jointeam good"));
      await f.closed;
    }
  },
);

test("a stop request wins when the owned process has exited during shutdown", async () => {
  await assert.rejects(
    waitAndJoin(
      options(
        { port: 30325 },
        {
          isOwned: async () => false,
          isStopping: async () => true,
        },
      ),
    ),
    (error) => {
      assert.equal(error.code, "LISTEN_HOST_CANCELLED");
      return true;
    },
  );
});

test(
  "each command repeats the ownership gate, even after the team command",
  { timeout: 4000 },
  async (t) => {
    let owned = true;
    const f = await serverFixture(t, (command) => {
      if (command === "status") return source1;
      if (command === "cmd jointeam good") owned = false;
    });
    await assert.rejects(
      waitAndJoin(options(f, { isOwned: async () => owned })),
      /进程/,
    );
    assert.equal(f.commands.filter((v) => v === "cmd jointeam good").length, 1);
    assert.ok(!f.commands.includes("bind F8 toggleconsole"));
    await f.closed;
  },
);

test(
  "map-loading deadline never reports ready or chooses a team",
  { timeout: 4000 },
  async (t) => {
    const f = await serverFixture(t, (command) =>
      command === "status"
        ? "map : dota\nplayers : 0 humans, 0 bots\n#end\n"
        : undefined,
    );
    const phases = [];
    await assert.rejects(
      waitAndJoin(
        options(f, {
          timeoutMs: 450,
          onPhase: async (phase) => phases.push(phase),
        }),
      ),
      /超时/,
    );
    assert.ok(!f.commands.includes("cmd jointeam good"));
    assert.ok(!phases.includes("ready"));
    await f.closed;
  },
);

test(
  "a match past hero selection gives an explicit reopen error",
  { timeout: 4000 },
  async (t) => {
    const f = await serverFixture(t, (command) =>
      command === "status"
        ? source1.replace("STATE_HERO_SELECTION", "STATE_PRE_GAME")
        : undefined,
    );
    await assert.rejects(waitAndJoin(options(f)), /错过选人阶段.*重新开服/);
    assert.ok(!f.commands.includes("cmd jointeam good"));
    await f.closed;
  },
);

test(
  "status overflow and socket close are errors, never readiness",
  { timeout: 6000 },
  async (t) => {
    for (const failure of ["overflow", "close"]) {
      const f = await serverFixture(t, (command, _commands, socket) => {
        if (command !== "status") return;
        if (failure === "overflow") return "x".repeat(65537);
        socket.end();
      });
      await assert.rejects(waitAndJoin(options(f)), /安全上限|连接已关闭/);
      assert.ok(!f.commands.includes("cmd jointeam good"));
      await f.closed;
    }
  },
);

test(
  "silent status and stalled ownership checks remain bounded",
  { timeout: 4000 },
  async (t) => {
    const f = await serverFixture(t);
    await assert.rejects(waitAndJoin(options(f, { timeoutMs: 300 })), /超时/);
    assert.ok(!f.commands.includes("cmd jointeam good"));
    await f.closed;
    await assert.rejects(
      waitAndJoin(
        options(
          { port: 30325 },
          { timeoutMs: 100, isOwned: () => new Promise(() => {}) },
        ),
      ),
      /身份超时/,
    );
  },
);

test("invalid control endpoints, secrets and timeouts are rejected without IO", async () => {
  let connections = 0;
  const base = options(
    { port: 30325 },
    {
      connect: () => {
        connections++;
        throw Error("unexpected IO");
      },
    },
  );
  for (const port of [0, 1023, 65536, 30325.5, "30325", Infinity])
    await assert.rejects(waitAndJoin({ ...base, port }), /端口/);
  for (const secret of [
    "a".repeat(47),
    "a".repeat(257),
    "x".repeat(64),
    password + "\nstatus",
    undefined,
  ])
    await assert.rejects(waitAndJoin({ ...base, password: secret }), /口令/);
  for (const timeoutMs of [0, -1, Infinity, 180001])
    await assert.rejects(waitAndJoin({ ...base, timeoutMs }), /参数/);
  assert.equal(connections, 0);
});
