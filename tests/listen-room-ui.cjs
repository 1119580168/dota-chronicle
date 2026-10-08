// Isolated room-guidance regression. No game, clipboard or user-config operations.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { _electron } = require("playwright");

const listenVersions = [
  "6.77c",
  "6.78b",
  "6.80c",
  "6.81",
  "6.83",
  "6.85b",
  "6.88c",
];

(async () => {
  const root = path.resolve(__dirname, ".."),
    out = path.join(root, "test-results");
  await fs.mkdir(out, { recursive: true });
  const data = await fs.mkdtemp(path.join(out, "listen-room-ui-"));
  const app = await _electron.launch({
    executablePath: process.env.CHRONICLE_TEST_EXE || require("electron"),
    args: process.env.CHRONICLE_TEST_EXE ? [] : [root],
    env: { ...process.env, CHRONICLE_DATA_DIR: data },
    timeout: 45000,
  });
  try {
    const page = await app.firstWindow(),
      errors = [],
      external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^(https?|wss?):/.test(request.url())) external.push(request.url());
    });
    await page.waitForSelector('[data-testid="nav-timeline"]', {
      timeout: 45000,
    });
    await page.context().setOffline(true);
    const snapshot = await page.evaluate(() => window.chronicle.snapshot());
    assert.equal(snapshot.entries.filter((entry) => entry.installed).length, 0);
    assert.deepEqual(snapshot.sessions, []);
    assert.deepEqual(
      snapshot.entries
        .filter((entry) => entry.listenHostBootstrap)
        .map((entry) => entry.id)
        .sort(),
      [...listenVersions].sort(),
    );
    const fixture = structuredClone(snapshot);
    for (const entry of fixture.entries) {
      if (!entry.playable || entry.prototype) continue;
      entry.installed = true;
      entry.root = path.join(data, "unlaunchable-fixture-" + entry.id);
    }
    fixture.networks = [{ name: "Fixture loopback", address: "127.0.0.1" }];
    fixture.room = {
      port: 30472,
      password: "fixture-room",
      bind: "",
      internet: false,
    };
    await app.evaluate(({ ipcMain }, value) => {
      const harness = { copied: [], blocked: [] };
      ipcMain.__chronicleRoomUi = harness;
      for (const name of ["snapshot", "status", "copy"])
        ipcMain.removeHandler("chronicle:" + name);
      ipcMain.handle("chronicle:snapshot", () => ({ ok: true, value }));
      ipcMain.handle("chronicle:status", () => ({
        ok: true,
        value: { sessions: [], configRevision: value.configRevision },
      }));
      // Record the exact clipboard payload without accessing the real clipboard.
      ipcMain.handle("chronicle:copy", (_event, text) => {
        harness.copied.push(text);
        return { ok: true, value: true };
      });
      for (const name of [
        "bind",
        "scan",
        "bindArchives",
        "package",
        "prepare",
        "launch",
        "host",
        "join",
        "stop",
        "fillBots",
        "saveRoom",
        "saveLaunchOptions",
        "openFolder",
        "importMedia",
      ]) {
        ipcMain.removeHandler("chronicle:" + name);
        ipcMain.handle("chronicle:" + name, () => {
          harness.blocked.push(name);
          throw Error("Forbidden operation in room UI test: " + name);
        });
      }
    }, fixture);
    await page.locator('[data-action="refresh"]').first().click();
    await page.waitForFunction(
      (count) =>
        document
          .querySelector(".statusbar")
          ?.textContent.includes(count + " 个比赛客户端"),
      fixture.entries.filter((entry) => entry.installed).length,
    );
    await page.locator('[data-testid="nav-room"]').click();
    await page.locator("#port").fill("30472");
    await page.locator("#password").fill("fixture-room");
    const roomRoute = page.locator('[data-testid="room-route"]');
    const listenHelp = page.locator('[data-testid="listen-host-team-help"]');
    const dedicatedHelp = page.locator('[data-testid="dedicated-team-help"]');
    const connectionOnly = 'password "fixture-room"\nconnect 127.0.0.1:30472';
    for (const version of listenVersions) {
      await page.locator("#roomVersion").selectOption(version);
      assert.equal(await page.locator("#roomMode").inputValue(), "bots");
      assert.match(await roomRoute.textContent(), /房主自动加入天辉/);
      assert.match(await roomRoute.textContent(), /其余真人席位保留/);
      assert.match(await roomRoute.textContent(), /游戏须保持开启/);
      assert.equal(await listenHelp.count(), 1);
      assert.equal(await dedicatedHelp.count(), 0);
      assert.match(await listenHelp.textContent(), /等待地图加载后/);
      assert.deepEqual(await listenHelp.locator("code").allTextContents(), [
        "jointeam good",
        "jointeam bad",
      ]);
      assert.equal(
        await page.locator(".code-block").textContent(),
        connectionOnly,
      );
      const prior = await app.evaluate(
        ({ ipcMain }) => ipcMain.__chronicleRoomUi.copied.length,
      );
      await page.locator('[data-action="copy"]').click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-action="copy"]')
          ?.classList.contains("copy-success"),
      );
      const copied = await app.evaluate(
        ({ ipcMain }) => ipcMain.__chronicleRoomUi.copied,
      );
      assert.equal(copied.length, prior + 1);
      assert.equal(copied.at(-1), connectionOnly);
      assert.doesNotMatch(copied.at(-1), /jointeam/);
    }

    await page.locator("#roomVersion").selectOption("7.32");
    assert.equal(await listenHelp.count(), 0);
    assert.equal(await dedicatedHelp.count(), 1);
    assert.deepEqual(await dedicatedHelp.locator("code").allTextContents(), [
      "jointeam 2",
      "jointeam 3",
    ]);
    assert.match(await roomRoute.textContent(), /专服 · 7.32/);
    assert.match(await roomRoute.textContent(), /房主加入并入队后，再补充 Bot/);

    // Other ordinary clients must not claim to use the older bootstrap route.
    for (const entry of fixture.entries.filter(
      (item) =>
        item.playable &&
        !item.prototype &&
        !item.listenHostBootstrap &&
        item.id !== "7.32",
    )) {
      await page.locator("#roomVersion").selectOption(entry.id);
      assert.equal(await listenHelp.count(), 0);
      assert.equal(await dedicatedHelp.count(), 0);
      assert.doesNotMatch(await roomRoute.textContent(), /自动加入天辉/);
    }

    // Official and community maps, including maps on flagged clients, never show
    // ordinary-match team instructions or the ordinary-host auto-team claim.
    const events = fixture.entries.flatMap((entry) => entry.events);
    for (const event of events) {
      await page.locator("#roomVersion").selectOption(event.version);
      await page.locator("#roomMode").selectOption(event.id);
      assert.equal(await listenHelp.count(), 0, event.id);
      assert.equal(await dedicatedHelp.count(), 0, event.id);
      assert.doesNotMatch(
        await roomRoute.textContent(),
        /自动加入天辉/,
        event.id,
      );
      assert.equal(
        await page.locator(".code-block").textContent(),
        connectionOnly,
      );
    }
    const harness = await app.evaluate(
      ({ ipcMain }) => ipcMain.__chronicleRoomUi,
    );
    assert.deepEqual(harness.blocked, []);
    assert.equal(
      await fs.access(path.join(data, "library.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(
      JSON.stringify({
        listenVersions,
        dedicatedInstructionsPreserved: true,
        rpgModesChecked: events.length,
        clipboardContainsOnlyConnection: true,
        gamesStarted: false,
        savedBindings: false,
        externalRequests: 0,
      }),
    );
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
