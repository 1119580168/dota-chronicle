// UI-only community-map regression checks. The real preload and media protocol
// run against an isolated data directory; every game/config operation is blocked.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  zlib = require("node:zlib"),
  assert = require("node:assert/strict");
const { _electron } = require("playwright");

const candidates = [
  {
    id: "warchasers",
    version: "6.88c",
    map: "warchasers",
    workshopId: "300989405",
    packageSha:
      "54f54721b29fcb6742c2e991a25c78aed84da661c01f9ea1256b4793fef39294",
  },
  {
    id: "horde-original",
    version: "7.22",
    map: "horde_5p",
    workshopId: "472597026",
    packageSha:
      "483b132581210cd2e18081839ea441a0a2e5845c796ad1dc00fd8e2c161bb0d4",
  },
  {
    id: "dota-mijing",
    version: "7.27c",
    map: "battlearena",
    workshopId: "1671200846",
    packageSha:
      "332418a899b9db137bab901aa15d4e94f55f93e26a6c7e1425c626cd606e4b30",
  },
  {
    id: "impossible-bosses",
    version: "7.32",
    map: "impossible_bosses",
    workshopId: "762688578",
    packageSha:
      "c8201db5c72857270e109b317a69736de97590cd38d538a20305d24938909bff",
  },
];

// Distinct generated pixels provide four identifiable, redistributable fixtures.
// Optionally read original covers from CHRONICLE_COMMUNITY_MEDIA_DIR, never write
// to that directory or save personal paths/art in the repository.
function pngFixture(rgb) {
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
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, ...rgb, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

(async () => {
  const root = path.resolve(__dirname, ".."),
    out = path.join(root, "test-results");
  await fs.mkdir(out, { recursive: true });
  const data = await fs.mkdtemp(path.join(out, "community-ui-")),
    mediaRoot = path.join(data, "media"),
    externalMedia = process.env.CHRONICLE_COMMUNITY_MEDIA_DIR,
    index = { schema: 1, assets: {}, targets: {} },
    pictures = {};
  await fs.mkdir(path.join(mediaRoot, "assets"), { recursive: true });
  for (const [position, candidate] of candidates.entries()) {
    const raw = externalMedia
        ? await fs.readFile(
            path.join(externalMedia, candidate.workshopId + "-cover.jpg"),
          )
        : pngFixture([40 + position * 40, 70 + position * 25, 100]),
      mediaId = crypto.createHash("sha256").update(raw).digest("hex"),
      extension = externalMedia ? ".jpg" : ".png",
      file = "assets/" + mediaId + extension;
    await fs.writeFile(path.join(mediaRoot, file), raw);
    index.assets[mediaId] = {
      file,
      kind: "cover",
      title: candidate.id + " cover",
      source: externalMedia
        ? "Read-only external cover copied to isolated test data"
        : "Generated regression fixture; no game content",
    };
    index.targets[candidate.id] = { cover: mediaId, videos: [] };
    pictures[candidate.id] = {
      id: mediaId,
      url: `chronicle://app/media/${mediaId}${extension}`,
      type: externalMedia ? "image/jpeg" : "image/png",
      ...index.assets[mediaId],
    };
  }
  assert.equal(new Set(Object.keys(index.assets)).size, 4);
  await fs.writeFile(path.join(mediaRoot, "index.json"), JSON.stringify(index));

  const electron = await _electron.launch({
    executablePath: process.env.CHRONICLE_TEST_EXE || require("electron"),
    args: process.env.CHRONICLE_TEST_EXE ? [] : [root],
    env: { ...process.env, CHRONICLE_DATA_DIR: data },
    timeout: 45000,
  });
  try {
    const page = await electron.firstWindow(),
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
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    const maps = [
      ...new Map(
        snapshot.entries.flatMap((entry) =>
          entry.events.map((event) => [event.id, event]),
        ),
      ).values(),
    ];
    assert.equal(maps.length, 16);
    assert.equal(
      maps.filter((event) => event.category === "official").length,
      9,
    );
    assert.equal(
      maps.filter((event) => event.category === "community").length,
      7,
    );

    const fixture = structuredClone(snapshot),
      clientMarker = "CLIENT_VALIDATION_MARKER";
    for (const candidate of candidates) {
      const client = fixture.entries.find(
          (entry) => entry.id === candidate.version,
        ),
        event = client?.events.find((item) => item.id === candidate.id),
        record = fixture.history.entries.find(
          (item) => item.runtimeId === candidate.version,
        );
      assert.ok(client && event && record, candidate.id + " is catalogued");
      assert.equal(event.category, "community");
      assert.equal(event.version, candidate.version);
      assert.equal(event.map, candidate.map);
      assert.equal(event.workshopId, candidate.workshopId);
      assert.equal(event.packageSha, candidate.packageSha);
      assert.ok(Number.isFinite(Date.parse(event.packageUpdatedUtc)));
      Object.assign(client, {
        installed: true,
        menuAvailable: true,
        root: path.join(data, "unlaunchable-fixture-" + candidate.version),
        verified: clientMarker,
        language: "english",
        languages: [{ code: "english", label: "English" }],
        languageNote: "UI fixture. ",
      });
      Object.assign(event, {
        available: true,
        // Production verification changes after real playtests. This deliberate
        // fixture checks pending-map status without constraining catalog progress.
        verified: "原包已核验 · 待基础试玩",
        note: "UI-only fixture; no launch or host operation is permitted.",
        media: { cover: pictures[candidate.id], shots: {}, videos: [] },
      });
      Object.assign(record, {
        owned: true,
        playable: true,
        localAvailable: true,
        hasVersion: true,
        availability: "local",
      });
    }

    // Replace only main-process handlers in this isolated test process. The UI
    // still calls the frozen production preload API over its actual IPC channel.
    await electron.evaluate(({ ipcMain }, value) => {
      const harness = { joins: [], blocked: [] },
        fixtureState = value;
      ipcMain.__chronicleCommunityUi = harness;
      for (const name of ["snapshot", "status", "join"])
        ipcMain.removeHandler("chronicle:" + name);
      ipcMain.handle("chronicle:snapshot", () => ({
        ok: true,
        value: fixtureState,
      }));
      ipcMain.handle("chronicle:status", () => ({
        ok: true,
        value: {
          sessions: fixtureState.sessions,
          configRevision: fixtureState.configRevision,
        },
      }));
      ipcMain.handle("chronicle:join", (_event, input) => {
        harness.joins.push(JSON.parse(JSON.stringify(input)));
        return { ok: true, value: { id: "ui-only-" + harness.joins.length } };
      });
      for (const name of [
        "bind",
        "scan",
        "bindArchives",
        "package",
        "prepare",
        "launch",
        "host",
        "stop",
        "fillBots",
        "saveRoom",
        "saveLaunchOptions",
        "openFolder",
        "copy",
        "importMedia",
      ]) {
        ipcMain.removeHandler("chronicle:" + name);
        ipcMain.handle("chronicle:" + name, () => {
          harness.blocked.push(name);
          throw Error("Forbidden operation in UI-only community test: " + name);
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
    assert.equal(
      await page.locator('[data-rpg-group="official"] .rpg').count(),
      9,
    );
    assert.equal(
      await page.locator('[data-rpg-group="community"] .rpg').count(),
      7,
    );
    await page.locator('[data-filter="official"]').click();
    assert.equal(await page.locator(".rpg").count(), 9);
    assert.equal(await page.locator('[data-rpg-group="community"]').count(), 0);

    const decoded = [];
    for (const candidate of candidates) {
      await page.locator('[data-testid="nav-rpg"]').click();
      await page.locator('[data-filter="community"]').click();
      assert.equal(await page.locator(".rpg").count(), 7);
      assert.equal(
        await page.locator('[data-rpg-group="official"]').count(),
        0,
      );
      const card = page.locator(`.rpg[data-event="${candidate.id}"]`),
        event = fixture.entries
          .flatMap((entry) => entry.events)
          .find((item) => item.id === candidate.id),
        picture = pictures[candidate.id];
      await card.click();
      assert.equal(await card.getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator('.rpg[aria-pressed="true"]').count(), 1);
      assert.equal(
        (
          await page.locator(".inspector .inspect-heading").textContent()
        ).trim(),
        event.name,
      );
      const status = (
        await page.locator(".detail-header .badge").textContent()
      ).trim();
      assert.equal(status, event.verified);
      assert.match(status, /待基础试玩/);
      assert.doesNotMatch(status, /基础试玩通过|CLIENT_VALIDATION_MARKER/);
      assert.equal(
        await page.locator(`[data-launch="${candidate.id}"]`).isEnabled(),
        true,
      );
      assert.equal(await card.locator("img").getAttribute("src"), picture.url);
      assert.equal(
        await page.locator(".cover-open img").getAttribute("src"),
        picture.url,
      );
      const dimensions = await card.locator("img").evaluate(async (image) => {
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      });
      assert.ok(dimensions.width > 0 && dimensions.height > 0);
      await page.locator(".cover-open").click();
      await page.waitForFunction(
        () => document.querySelector("#mediaViewer")?.open,
      );
      const viewerDimensions = await page
        .locator("#mediaViewer img")
        .evaluate(async (image) => {
          await image.decode();
          return { width: image.naturalWidth, height: image.naturalHeight };
        });
      assert.deepEqual(viewerDimensions, dimensions);
      assert.equal(
        await page.locator("#mediaViewer img").getAttribute("src"),
        picture.url,
      );
      await page.locator('[data-action="closeMedia"]').click();
      await page.waitForFunction(
        () => !document.querySelector("#mediaViewer").open,
      );
      decoded.push({ id: candidate.id, ...dimensions });

      // The public room route must retain the selected community map. The join
      // handler above records arguments only and cannot start a game or worker.
      await page.locator(`[data-room-event="${candidate.id}"]`).click();
      assert.equal(
        await page.locator("#roomVersion").inputValue(),
        candidate.version,
      );
      assert.equal(await page.locator("#roomMode").inputValue(), candidate.id);
      assert.equal(
        await page
          .locator(`#roomMode option[value="${candidate.id}"]`)
          .evaluate((option) => option.parentElement.label),
        "游廊 RPG",
      );
      await page.locator("#server").fill("127.0.0.1");
      await page.locator("#port").fill("30471");
      await page.locator("#password").fill("fixture-room");
      await page
        .locator("#server")
        .evaluate((input) => (input.dataset.beforeJoin = "yes"));
      await page.locator('[data-action="join"]').click();
      await page.waitForFunction(
        () => !document.querySelector("#server")?.dataset.beforeJoin,
      );
      const calls = await electron.evaluate(
        ({ ipcMain }) => ipcMain.__chronicleCommunityUi.joins,
      );
      assert.equal(calls.length, decoded.length);
      assert.equal(calls.at(-1).id, candidate.version);
      assert.equal(calls.at(-1).joinMode, candidate.id);
      assert.equal(calls.at(-1).server, "127.0.0.1");
      assert.equal(calls.at(-1).room.port, 30471);
      assert.equal(calls.at(-1).room.password, "fixture-room");
    }

    // An explicit return to ordinary matches must not reuse the prior RPG mode.
    await page.locator("#roomMode").selectOption("bots");
    await page
      .locator("#server")
      .evaluate((input) => (input.dataset.beforeJoin = "yes"));
    await page.locator('[data-action="join"]').click();
    await page.waitForFunction(
      () => !document.querySelector("#server")?.dataset.beforeJoin,
    );
    const harness = await electron.evaluate(
      ({ ipcMain }) => ipcMain.__chronicleCommunityUi,
    );
    assert.equal(harness.joins.length, 5);
    assert.equal(harness.joins.at(-1).joinMode, "bots");
    assert.deepEqual(harness.blocked, []);
    assert.equal(
      (await page.evaluate(() => window.chronicle.snapshot())).sessions.length,
      0,
    );
    assert.equal(
      await fs.access(path.join(data, "library.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const report = {
      total: 16,
      official: 9,
      community: 7,
      pendingValidationIsMapSpecific: true,
      mediaSource: externalMedia ? "external-originals" : "generated-fixtures",
      decoded,
      joinModes: harness.joins.map((input) => input.joinMode),
      offline: true,
      savedBindings: false,
      gamesStarted: false,
    };
    await fs.writeFile(
      path.join(out, "community-ui.json"),
      JSON.stringify(report, null, 2),
    );
    console.log("Community UI passed: " + JSON.stringify(report));
  } finally {
    await electron.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
