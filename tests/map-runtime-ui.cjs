// Real preload/IPC regression for one map shared by several clients. All game,
// folder and configuration operations are replaced with in-memory recorders.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  zlib = require("node:zlib"),
  assert = require("node:assert/strict");
const { _electron } = require("playwright");

const mapId = "wikibox-old",
  versions = ["7.27c", "7.30e", "7.32", "7.37e"],
  packageSha =
    "104387b25b7ebe77ef00e9d7456b2ba3a42eddc7b0b7a2696132897f98d63442",
  blockedReason = "UI fixture：此客户端缺少所需接口，禁止启动。";

function fixturePng() {
  const chunk = (name, raw) => {
    const body = Buffer.concat([Buffer.from(name), raw]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(raw.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 92, 64, 44, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

(async () => {
  const root = path.resolve(__dirname, ".."),
    out = path.join(root, "test-results");
  await fs.mkdir(out, { recursive: true });
  const data = await fs.mkdtemp(path.join(out, "map-runtime-ui-")),
    raw = fixturePng(),
    mediaId = crypto.createHash("sha256").update(raw).digest("hex"),
    mediaRoot = path.join(data, "media"),
    picture = {
      id: mediaId,
      file: `assets/${mediaId}.png`,
      url: `chronicle://app/media/${mediaId}.png`,
      type: "image/png",
      kind: "cover",
      title: "Shared map regression fixture",
      source: "Generated test pixel; no game content",
    };
  await fs.mkdir(path.join(mediaRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(mediaRoot, picture.file), raw);
  await fs.writeFile(
    path.join(mediaRoot, "index.json"),
    JSON.stringify({
      schema: 1,
      assets: { [mediaId]: picture },
      targets: { [mapId]: { cover: mediaId, videos: [] } },
    }),
  );
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
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.context().setOffline(true);
    await page.reload();
    await page.waitForSelector('[data-testid="nav-timeline"]');
    const snapshot = await page.evaluate(() => window.chronicle.snapshot());
    assert.equal(snapshot.entries.filter((entry) => entry.installed).length, 0);
    assert.deepEqual(snapshot.sessions, []);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");

    const fixture = structuredClone(snapshot),
      uniqueMaps = new Map(
        fixture.entries.flatMap((entry) =>
          entry.events.map((event) => [event.id, event]),
        ),
      );
    assert.equal(uniqueMaps.size, 16);
    assert.equal(
      [...uniqueMaps.values()].filter((event) => event.category === "community")
        .length,
      7,
    );
    const fixtureStatuses = {
      "7.27c": "7.27c 原包 · 基础试玩通过",
      "7.30e": "7.30e 原包 · 待基础试玩",
      7.32: "7.32 默认构建 · 待基础试玩",
      "7.37e": "7.37e 原包 · 待基础试玩",
    };
    const fixtureNotes = {
      "7.27c": "7.27c fixture：只验证移动，严格断网仍待测试。",
      "7.30e": "7.30e fixture：逐级升级可用，LevelMax 缺少 <HeroMaxLevel>。",
      7.32: "7.32 fixture：基础工具已验证，完整功能与多人仍待测试。",
      "7.37e": "7.37e fixture：接口不兼容，禁止此组合启动。",
    };
    for (const id of versions) {
      const client = fixture.entries.find((entry) => entry.id === id),
        event = client?.events.find((event) => event.id === mapId);
      assert.ok(event, id + " has the shared map");
      assert.equal(event.version, id);
      assert.equal(event.defaultVersion, "7.32");
      assert.equal(event.archiveType, "snapshot");
      assert.equal(event.packageSha, packageSha);
      assert.equal(event.workshopId, "2781880190");
      assert.equal(event.map, "dota");
      Object.assign(client, {
        installed: true,
        menuAvailable: true,
        root: path.join(data, "unlaunchable-fixture-" + id),
        verified: "CLIENT_VALIDATION_MUST_NOT_LEAK",
        language: id === "7.30e" ? "english" : "schinese",
        languages: [
          { code: "english", label: "English" },
          { code: "schinese", label: "简体中文" },
        ],
        languageNote: "UI fixture. ",
      });
      // Deliberate fixture states must not depend on real playtest progress.
      Object.assign(event, {
        available: id !== "7.37e",
        verified: fixtureStatuses[id],
        validationNotes: fixtureNotes[id],
        launchDisabledReason: id === "7.37e" ? blockedReason : "",
        note: id === "7.37e" ? blockedReason : "UI-only fixture.",
        media: { cover: picture, shots: {}, videos: [] },
      });
    }
    fixture.networks = [{ name: "Fixture loopback", address: "127.0.0.1" }];
    fixture.room = {
      port: 30473,
      password: "fixture-room",
      bind: "",
      internet: false,
    };

    await app.evaluate(({ ipcMain }, value) => {
      const harness = { calls: [], blocked: [] };
      ipcMain.__chronicleMapRuntimeUi = harness;
      ipcMain.__chronicleMapRuntimeFixture = value;
      for (const name of ["snapshot", "status"])
        ipcMain.removeHandler("chronicle:" + name);
      ipcMain.handle("chronicle:snapshot", () => ({ ok: true, value }));
      ipcMain.handle("chronicle:status", () => ({
        ok: true,
        value: { sessions: [], configRevision: value.configRevision },
      }));
      for (const name of [
        "launch",
        "host",
        "join",
        "openFolder",
        "saveLaunchOptions",
        "saveRoom",
      ]) {
        ipcMain.removeHandler("chronicle:" + name);
        ipcMain.handle("chronicle:" + name, (_event, input) => {
          harness.calls.push({ name, input: structuredClone(input) });
          if (name === "saveLaunchOptions") {
            const client = value.entries.find((entry) => entry.id === input.id);
            client.language = input.language;
            value.configRevision++;
          }
          if (name === "saveRoom") value.room = structuredClone(input);
          return { ok: true, value: true };
        });
      }
      for (const name of [
        "bind",
        "scan",
        "bindArchives",
        "package",
        "prepare",
        "stop",
        "fillBots",
        "copy",
        "importMedia",
      ]) {
        ipcMain.removeHandler("chronicle:" + name);
        ipcMain.handle("chronicle:" + name, () => {
          harness.blocked.push(name);
          throw Error("Forbidden operation in map runtime UI test: " + name);
        });
      }
    }, fixture);
    await page.locator('[data-action="refresh"]').first().click();
    await page.waitForFunction(() =>
      document
        .querySelector(".statusbar")
        ?.textContent.includes("4 个比赛客户端"),
    );
    await page.locator('[data-testid="nav-rpg"]').click();
    assert.equal(await page.locator(".rpg").count(), 16);
    await page.locator('[data-filter="community"]').click();
    assert.equal(await page.locator(".rpg").count(), 7);
    assert.equal(await page.locator(`.rpg[data-event="${mapId}"]`).count(), 1);
    await page.locator('.rpg[data-event="warchasers"]').click();
    assert.equal(await page.locator("[data-event-client]").count(), 0);
    assert.equal(
      await page.locator('[data-testid="map-runtime-validation"]').count(),
      0,
    );
    assert.match(
      await page.locator(".detail-subline").textContent(),
      /停更游廊/,
    );
    await page.locator(`.rpg[data-event="${mapId}"]`).click();
    const selector = page.locator(`[data-event-client="${mapId}"]`),
      status = page.locator(".detail-header .badge"),
      launch = page.locator(`[data-launch="${mapId}"]`),
      calls = () =>
        app.evaluate(({ ipcMain }) => ipcMain.__chronicleMapRuntimeUi.calls);
    assert.equal(await selector.inputValue(), "7.32");
    assert.equal(
      await page
        .locator('[data-testid="map-runtime-validation"]')
        .textContent(),
      fixtureNotes["7.32"],
    );
    assert.match(
      await page.locator(".detail-subline").textContent(),
      /游廊历史快照/,
    );
    assert.deepEqual(
      await selector
        .locator("option")
        .evaluateAll((options) => options.map((option) => option.value)),
      versions,
    );
    assert.match(await status.textContent(), /7\.32 默认构建 · 待基础试玩/);
    assert.doesNotMatch(
      await status.textContent(),
      /基础试玩通过|CLIENT_VALIDATION/,
    );
    assert.equal(await page.locator(".detail-version").textContent(), "7.32");
    assert.equal(
      await page.locator(".cover-open img").getAttribute("src"),
      picture.url,
    );
    await page.locator(".cover-open img").evaluate((image) => image.decode());

    for (const id of versions) {
      await selector.selectOption(id);
      assert.equal(await page.locator(".detail-version").textContent(), id);
      assert.equal(
        await page
          .locator('.detail-launch [data-testid="map-runtime-validation"]')
          .textContent(),
        fixtureNotes[id],
      );
      assert.equal(
        await page.locator(`[data-launch-language="${id}"]`).count(),
        1,
      );
      assert.equal(
        await page.locator(".cover-open img").getAttribute("src"),
        picture.url,
      );
      assert.doesNotMatch(await status.textContent(), /CLIENT_VALIDATION/);
      if (id === "7.37e") {
        assert.equal(await launch.isEnabled(), false);
        assert.equal((await status.textContent()).trim(), "已发现不兼容");
        assert.equal(
          (
            await page
              .locator('[data-testid="map-runtime-reason"]')
              .textContent()
          ).trim(),
          blockedReason,
        );
      } else {
        assert.equal((await status.textContent()).trim(), fixtureStatuses[id]);
        assert.equal(await launch.isEnabled(), true);
        const previous = (await calls()).length;
        await launch.evaluate((button) => (button.dataset.pendingTest = "yes"));
        await launch.click();
        await page.waitForFunction(
          () =>
            !document.querySelector('[data-launch="wikibox-old"]')?.dataset
              .pendingTest,
        );
        const last = (await calls()).at(-1);
        assert.equal((await calls()).length, previous + 1);
        assert.deepEqual(last, { name: "launch", input: { id, mode: mapId } });
      }
    }
    await selector.selectOption("7.30e");
    const language = page.locator('[data-launch-language="7.30e"]');
    assert.equal(await language.inputValue(), "english");
    await language.selectOption("schinese");
    await page.waitForFunction(() =>
      document.querySelector("#toast")?.textContent.includes("语言已保存"),
    );
    assert.deepEqual((await calls()).at(-1), {
      name: "saveLaunchOptions",
      input: { id: "7.30e", language: "schinese" },
    });
    await selector.selectOption("7.27c");
    assert.equal(
      await page.locator('[data-launch-language="7.27c"]').inputValue(),
      "schinese",
    );
    await selector.selectOption("7.30e");
    assert.equal(await language.inputValue(), "schinese");
    await page.locator('[data-action="clientFolder"]').click();
    assert.deepEqual((await calls()).at(-1), {
      name: "openFolder",
      input: { kind: "client", id: "7.30e" },
    });
    await page.locator('[data-action="refresh"]').first().click();
    assert.equal(await selector.inputValue(), "7.30e");
    await page.locator('.rpg[data-event="warchasers"]').click();
    await page.locator(`.rpg[data-event="${mapId}"]`).click();
    assert.equal(await selector.inputValue(), "7.30e");

    await page.locator(`[data-room-event="${mapId}"]`).click();
    assert.equal(await page.locator("#roomVersion").inputValue(), "7.30e");
    assert.equal(await page.locator("#roomMode").inputValue(), mapId);
    assert.match(
      await page.locator('[data-testid="room-map-status"]').textContent(),
      /7\.30e 原包 · 待基础试玩/,
    );
    assert.equal(
      await page.locator('[data-testid="room-map-validation"]').textContent(),
      fixtureNotes["7.30e"],
    );
    await page.locator("#server").fill("127.0.0.1");
    await page.locator("#port").fill("30473");
    await page.locator("#password").fill("fixture-room");
    await page.locator('[data-action="host"]').click();
    await page.waitForFunction(() =>
      document.querySelector("#toast")?.textContent.includes("开服任务已提交"),
    );
    const host = (await calls()).at(-1);
    assert.equal(host.name, "host");
    assert.equal(host.input.id, "7.30e");
    assert.equal(host.input.mode, mapId);
    assert.equal(host.input.room.port, 30473);
    await page.locator('[data-action="join"]').click();
    await page.waitForFunction(() =>
      document.querySelector("#toast")?.textContent.includes("正在连接房主"),
    );
    const join = (await calls()).at(-1);
    assert.equal(join.name, "join");
    assert.equal(join.input.id, "7.30e");
    assert.equal(join.input.joinMode, mapId);
    assert.equal(join.input.server, "127.0.0.1");
    assert.equal(join.input.room.password, "fixture-room");
    await page.locator("#roomVersion").selectOption("7.27c");
    assert.equal(await page.locator("#roomMode").inputValue(), mapId);
    assert.match(
      await page.locator('[data-testid="room-map-status"]').textContent(),
      /7\.27c 原包 · 基础试玩通过/,
    );
    assert.equal(
      await page.locator('[data-testid="room-map-validation"]').textContent(),
      fixtureNotes["7.27c"],
    );
    await page.locator("#roomVersion").selectOption("7.37e");
    assert.equal(await page.locator("#roomMode").inputValue(), mapId);
    assert.equal(await page.locator('[data-action="host"]').isEnabled(), false);
    assert.equal(await page.locator('[data-action="join"]').isEnabled(), false);
    assert.equal(
      await page.locator('[data-testid="room-map-validation"]').textContent(),
      fixtureNotes["7.37e"],
    );
    assert.equal(
      (
        await page.locator('[data-testid="room-map-unavailable"]').textContent()
      ).trim(),
      blockedReason,
    );
    await page.locator("#roomVersion").selectOption("6.88c");
    assert.equal(await page.locator("#roomMode").inputValue(), "bots");
    assert.equal(
      await page.locator('[data-testid="room-map-status"]').count(),
      0,
    );
    assert.equal(
      await page.locator('[data-testid="room-map-validation"]').count(),
      0,
    );
    assert.match(
      await page.locator("#toast").textContent(),
      /已切换为普通比赛/,
    );

    // Shared media stays visible when the selected client is unbound. Another
    // client's trial cannot grant this client launch availability.
    await app.evaluate(({ ipcMain }) => {
      const value = ipcMain.__chronicleMapRuntimeFixture,
        client = value.entries.find((entry) => entry.id === "7.32"),
        event = client.events.find((event) => event.id === "wikibox-old");
      Object.assign(client, {
        installed: false,
        menuAvailable: false,
        root: null,
      });
      Object.assign(event, { available: false, note: "请先绑定客户端。" });
      value.configRevision++;
    });
    await page.locator('[data-testid="nav-rpg"]').click();
    await page.locator(`.rpg[data-event="${mapId}"]`).click();
    await page.locator('[data-action="refresh"]').first().click();
    await selector.selectOption("7.32");
    assert.equal(
      await page.locator(".cover-open img").getAttribute("src"),
      picture.url,
    );
    assert.equal((await status.textContent()).trim(), "请先绑定客户端");
    assert.equal(await launch.count(), 0);
    assert.equal(await page.locator('[data-bind="7.32"]').isEnabled(), true);
    await selector.selectOption("7.30e");
    assert.equal(await launch.isEnabled(), true);
    assert.equal((await status.textContent()).trim(), fixtureStatuses["7.30e"]);

    const harness = await app.evaluate(
      ({ ipcMain }) => ipcMain.__chronicleMapRuntimeUi,
    );
    assert.deepEqual(harness.blocked, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(
      (await page.evaluate(() => window.chronicle.snapshot())).sessions,
      [],
    );
    assert.equal(
      await fs.access(path.join(data, "library.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
    const report = {
      uniqueMaps: 16,
      runtimeChoices: versions,
      defaultVersion: "7.32",
      sharedMediaAssets: 1,
      verificationPerClient: true,
      validationNotesPerClient: true,
      launchHostJoinBlockedWhenIncompatible: true,
      calls: harness.calls,
      offline: true,
      savedBindings: false,
      gamesStarted: false,
    };
    await fs.writeFile(
      path.join(out, "map-runtime-ui.json"),
      JSON.stringify(report, null, 2),
    );
    console.log("Map runtime UI passed: " + JSON.stringify(report));
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
