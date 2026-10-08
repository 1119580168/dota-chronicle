// Isolated renderer regression checks. No games, native UI, or user configuration.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  zlib = require("node:zlib"),
  assert = require("node:assert/strict");
const { _electron } = require("playwright");

// A generated 1 px test image exercises the actual local media protocol without
// borrowing copyrighted game art or referring to a user's media directory.
function pngFixture() {
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
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 220, 220, 220, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

(async () => {
  const root = path.resolve(__dirname, ".."),
    out = path.join(root, "test-results");
  await fs.mkdir(out, { recursive: true });
  const data = await fs.mkdtemp(path.join(out, "ui-experience-")),
    raw = pngFixture(),
    mediaId = crypto.createHash("sha256").update(raw).digest("hex"),
    mediaRoot = path.join(data, "media");
  await fs.mkdir(path.join(mediaRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(mediaRoot, "assets", mediaId + ".png"), raw);
  await fs.writeFile(
    path.join(mediaRoot, "index.json"),
    JSON.stringify({
      schema: 1,
      assets: {
        [mediaId]: {
          file: "assets/" + mediaId + ".png",
          kind: "menu",
          title: "UI regression fixture",
          source: "Generated test image; no game content",
        },
      },
      targets: { "7.00": { cover: mediaId, menu: mediaId, videos: [] } },
    }),
  );
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

    const search = page.locator('[data-testid="search"]'),
      rows = page.locator("[data-history]");
    await page.locator('[data-testid="nav-timeline"]').focus();
    await page.keyboard.press("Control+f");
    assert.equal(
      await search.evaluate((input) => input === document.activeElement),
      true,
    );
    await search.fill("7.20c");
    assert.equal(await rows.count(), 1);
    await page.locator(".search-clear").click();
    assert.equal(await search.inputValue(), "");
    assert.equal(await rows.count(), snapshot.history.entries.length);
    await page.locator('[data-testid="nav-timeline"]').focus();
    await page.keyboard.press("Control+k");
    assert.equal(
      await search.evaluate((input) => input === document.activeElement),
      true,
    );
    await search.fill("not-a-real-history-record-92741");
    assert.equal(await rows.count(), 0);
    await page.locator('.clear-search[data-action="clearSearch"]').click();
    assert.equal(await search.inputValue(), "");
    assert.equal(await rows.count(), snapshot.history.entries.length);
    await search.fill("6.80c");
    await page.keyboard.press("Escape");
    assert.equal(await search.inputValue(), "");
    assert.equal(await rows.count(), snapshot.history.entries.length);

    // Clearing query text must not silently broaden the user's chosen scope.
    // Empty local collections retain their filter until the explicit reset action.
    await page.locator('[data-filter="owned"]').click();
    await search.fill("7.00");
    await page.locator(".search-clear").click();
    assert.equal(await search.inputValue(), "");
    assert.equal(
      await page.locator('[data-filter="owned"]').getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await rows.count(), 0);
    await search.fill("7.00");
    await page.keyboard.press("Escape");
    assert.equal(await search.inputValue(), "");
    assert.equal(
      await page.locator('[data-filter="owned"]').getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await rows.count(), 0);
    await page.locator('.clear-search[data-action="clearSearch"]').click();
    assert.equal(
      await page.locator('[data-filter="all"]').getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await rows.count(), snapshot.history.entries.length);

    // Chinese IME must retain the composing input node and avoid filtering on
    // intermediate syllables. The final Chinese query is a real RPG search.
    const moonClient = snapshot.entries.find((entry) =>
      entry.events.some((event) => event.name.includes("暗月")),
    );
    assert.ok(moonClient, "the catalog contains the Dark Moon event");
    const composing = await search.evaluate((input) => {
      input.focus();
      input.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      input.value = "an";
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "an",
          isComposing: true,
        }),
      );
      return {
        connected: input.isConnected,
        focused: document.activeElement === input,
        rows: document.querySelectorAll("[data-history]").length,
      };
    });
    assert.deepEqual(composing, {
      connected: true,
      focused: true,
      rows: snapshot.history.entries.length,
    });
    await search.evaluate((input) => {
      input.value = "暗月";
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "暗月",
          isComposing: true,
        }),
      );
      input.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: "暗月",
        }),
      );
    });
    await page.waitForFunction(
      () =>
        document.querySelector("#search")?.value === "暗月" &&
        document.querySelectorAll("[data-history]").length === 1,
    );
    assert.equal(await rows.first().getAttribute("data-select"), moonClient.id);
    await page.keyboard.press("Escape");

    // Clicking a history record preserves the context being browsed, including
    // expanded maintenance updates, and announces selection to assistive tools.
    const previousTop = await page
      .locator(".client-updates")
      .first()
      .evaluate((group) => {
        group.open = true;
        const content = document.querySelector("#content");
        content.scrollTop = 480;
        const top = content.scrollTop;
        group.querySelector("[data-history]").click();
        return top;
      });
    assert.equal(
      await page.locator("#content").evaluate((el) => el.scrollTop),
      previousTop,
    );
    assert.equal(
      await page
        .locator(".client-updates")
        .first()
        .evaluate((el) => el.open),
      true,
    );
    assert.equal(
      await page.locator('[data-history][aria-pressed="true"]').count(),
      1,
    );
    assert.equal(
      await rows.evaluateAll((items) =>
        items.every((el) => el.hasAttribute("aria-pressed")),
      ),
      true,
    );

    // Year status follows scrolling, rather than the separately selected client.
    await page.locator('[data-year="2018"]').click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('.year-jumps [data-year="2018"]')
          ?.getAttribute("aria-current") === "date",
    );
    assert.equal(
      await page.locator('.year-jumps [aria-current="date"]').count(),
      1,
    );

    await search.fill("7.20c");
    await page.locator('[data-history="patch-7.20c"]').click();
    const disclosure = page
      .locator(".inspector details[data-disclosure-key]")
      .first();
    assert.equal(await disclosure.count(), 1);
    await disclosure.locator("summary").click();
    const disclosureKey = await disclosure.getAttribute("data-disclosure-key");
    // Constrain a fixture pane to ensure scroll restoration is checked even if
    // editorial copy becomes shorter. This changes no authoring or saved data.
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(".inspector{max-height:260px!important}");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    const paneTop = await page.locator(".inspector").evaluate((pane) => {
      pane.scrollTop = 120;
      return pane.scrollTop;
    });
    assert.ok(paneTop > 0, "the expanded fixture inspector can scroll");
    await search.focus();
    await search.evaluate((input) => {
      input.dataset.experienceRefreshWitness = "before-refresh";
      input.setSelectionRange(1, 4, "backward");
    });
    // A direct button activation avoids moving focus/scroll before the refresh;
    // it still follows the real renderer click and IPC snapshot path.
    await page
      .locator('[data-action="refresh"]')
      .first()
      .evaluate((button) => button.click());
    await page.waitForFunction(() => {
      const input = document.querySelector("#search");
      return (
        document.activeElement === input &&
        !input?.hasAttribute("data-experience-refresh-witness")
      );
    });
    assert.deepEqual(
      await search.evaluate((input) => ({
        start: input.selectionStart,
        end: input.selectionEnd,
        direction: input.selectionDirection,
      })),
      { start: 1, end: 4, direction: "backward" },
    );
    assert.equal(
      await page.locator(".inspector").evaluate((pane) => pane.scrollTop),
      paneTop,
    );
    assert.equal(
      await page
        .locator(`.inspector details[data-disclosure-key="${disclosureKey}"]`)
        .evaluate((el) => el.open),
      true,
    );
    // Keyboard users browsing an expanded disclosure keep the same logical
    // summary focused after refresh, despite replacement of its DOM element.
    await page
      .locator(
        `.inspector details[data-disclosure-key="${disclosureKey}"] summary`,
      )
      .evaluate((summary) => {
        summary.dataset.experienceSummaryWitness = "before-refresh";
        summary.focus({ preventScroll: true });
      });
    await page
      .locator('[data-action="refresh"]')
      .first()
      .evaluate((button) => button.click());
    await page.waitForFunction((key) => {
      const summary = document.activeElement;
      return (
        summary?.tagName === "SUMMARY" &&
        summary.closest(".inspector") &&
        summary.parentElement.dataset.disclosureKey === key &&
        !summary.hasAttribute("data-experience-summary-witness")
      );
    }, disclosureKey);
    assert.equal(
      await page
        .locator(`.inspector details[data-disclosure-key="${disclosureKey}"]`)
        .evaluate((el) => el.open),
      true,
    );
    assert.equal(
      await page.locator(".inspector").evaluate((pane) => pane.scrollTop),
      paneTop,
    );
    await search.fill("7.22");
    await page.locator('[data-history="patch-7.22"]').click();
    assert.equal(
      await page.locator(".inspector").evaluate((pane) => pane.scrollTop),
      0,
    );

    // RPG navigation/category changes must show a selected map and its own
    // detail/actions, never leave the previously selected ordinary client behind.
    // Derive the title from the selected event ID, rather than a fixed first map.
    const assertSelectedMap = async (category) => {
      const selectedCard = page.locator('.rpg[aria-pressed="true"]');
      assert.equal(await selectedCard.count(), 1);
      const id = await selectedCard.getAttribute("data-event"),
        map = snapshot.entries
          .flatMap((entry) => entry.events)
          .find((event) => event.id === id);
      assert.ok(map, "the selected card is a registered map");
      if (category) {
        assert.equal(map.category, category);
        assert.equal(
          await selectedCard.getAttribute("data-rpg-category"),
          category,
        );
      }
      assert.equal(
        (
          await page.locator(".inspector .inspect-heading").textContent()
        ).trim(),
        map.name,
      );
      assert.equal(await page.locator('[data-launch="bots"]').count(), 0);
    };
    await page.locator('[data-testid="nav-rpg"]').click();
    await assertSelectedMap();
    await page.locator('[data-filter="official"]').click();
    await assertSelectedMap("official");
    await page.locator('[data-filter="community"]').click();
    await assertSelectedMap("community");
    await page.locator('[data-filter="official"]').click();
    await assertSelectedMap("official");
    await page.locator('[data-filter="community"]').click();
    await assertSelectedMap("community");
    await page.locator('.rpg[data-event="epic-boss-fight"]').click();
    await assertSelectedMap("community");
    assert.equal(
      await page
        .locator('[data-filter="community"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await page.locator('[data-rpg-group="official"]').count(), 0);
    assert.equal(await page.locator('[data-testid="search"]').inputValue(), "");
    const communityCount = await page.locator(".rpg").count();
    await search.fill("Epic");
    assert.equal(await page.locator(".rpg").count(), 1);
    await page.locator(".search-clear").click();
    assert.equal(await search.inputValue(), "");
    assert.equal(
      await page
        .locator('[data-filter="community"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await page.locator(".rpg").count(), communityCount);
    assert.equal(await page.locator('[data-rpg-group="official"]').count(), 0);
    await search.fill("not-a-real-community-map-18352");
    assert.equal(await page.locator(".rpg").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await search.inputValue(), "");
    assert.equal(
      await page
        .locator('[data-filter="community"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await page.locator(".rpg").count(), communityCount);
    assert.equal(await page.locator('[data-rpg-group="official"]').count(), 0);

    // The main-process test harness supplies read-only public snapshots through
    // real preload IPC. No test API or global is added to production renderer code.
    const fixture = structuredClone(snapshot),
      client = fixture.entries.find((entry) => entry.id === "7.00"),
      record = fixture.history.entries.find(
        (entry) => entry.runtimeId === "7.00",
      ),
      picture = {
        id: mediaId,
        url: `chronicle://app/media/${mediaId}.png`,
        type: "image/png",
        kind: "menu",
        title: "UI regression fixture",
        source: "Generated test image; no game content",
        build: "fixture",
      };
    assert.ok(client && record);
    Object.assign(client, {
      installed: true,
      menuAvailable: true,
      root: path.join(data, "unlaunchable-fixture"),
      media: { cover: picture, shots: { menu: picture }, videos: [] },
      language: "english",
      languages: [{ code: "english", label: "English" }],
      languageNote: "UI fixture. ",
    });
    Object.assign(record, {
      owned: true,
      playable: true,
      localAvailable: true,
      hasVersion: true,
      availability: "local",
    });
    await electron.evaluate(({ ipcMain }, value) => {
      const fixtureState = value;
      for (const name of ["snapshot", "status"])
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
      ipcMain.on("chronicle-experience-test-sessions", (_event, sessions) => {
        fixtureState.sessions = sessions;
      });
      // Any accidental game or write operation must fail before reaching a worker.
      for (const name of [
        "launch",
        "host",
        "join",
        "stop",
        "prepare",
        "saveLaunchOptions",
      ]) {
        ipcMain.removeHandler("chronicle:" + name);
        ipcMain.handle("chronicle:" + name, () => {
          throw Error(
            "Forbidden mutating operation in UI-only experience test: " + name,
          );
        });
      }
    }, fixture);
    await page.locator('[data-testid="nav-timeline"]').click();
    await page.locator('[data-action="refresh"]').first().click();
    await page.waitForSelector(`[data-history="${record.id}"].owned`, {
      state: "attached",
    });
    await search.fill("7.00");
    await page.locator(`[data-history="${record.id}"]`).click();
    const launch = page.locator('[data-launch="bots"]');
    assert.equal(await launch.isEnabled(), true);
    await search.focus();
    await search.evaluate((input) => {
      input.dataset.experienceWitness = "stable-input";
      input.setSelectionRange(1, 3);
    });
    const session = {
      id: "12345678-1234-1234-1234-123456789012",
      version: "7.00",
      mode: "bots",
      type: "client",
      stage: "running",
      pid: null,
    };
    await electron.evaluate(
      ({ ipcMain }, sessions) =>
        ipcMain.emit("chronicle-experience-test-sessions", null, sessions),
      [session],
    );
    await page.waitForFunction(
      () => document.querySelector('[data-launch="bots"]')?.disabled === true,
    );
    assert.equal(
      await search.getAttribute("data-experience-witness"),
      "stable-input",
    );
    assert.equal(
      await search.evaluate((input) => document.activeElement === input),
      true,
    );
    assert.equal(await page.locator('[data-launch="menu"]').isDisabled(), true);
    await electron.evaluate(
      ({ ipcMain }, sessions) =>
        ipcMain.emit("chronicle-experience-test-sessions", null, sessions),
      [{ ...session, stage: "finished" }],
    );
    await page.waitForFunction(
      () => document.querySelector('[data-launch="bots"]')?.disabled === false,
    );
    assert.equal(
      await search.getAttribute("data-experience-witness"),
      "stable-input",
    );
    assert.deepEqual(
      await search.evaluate((input) => ({
        start: input.selectionStart,
        end: input.selectionEnd,
        focused: document.activeElement === input,
      })),
      { start: 1, end: 3, focused: true },
    );

    // Escape belongs to the media viewer while it is open; it must not clear the
    // underlying search. Exiting fullscreen keeps the same dialog and media.
    await page.locator(".shot[data-media]").first().click();
    await page.waitForFunction(
      () => document.querySelector("#mediaViewer")?.open,
    );
    await page.waitForFunction(() => {
      const image = document.querySelector("#mediaViewer img");
      return image?.complete && image.naturalWidth === 1;
    });
    await page.locator('#mediaViewer [data-action="mediaFullscreen"]').click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.fullscreenElement);
    assert.equal(
      await page.locator("#mediaViewer").evaluate((dialog) => dialog.open),
      true,
    );
    assert.equal(await search.inputValue(), "7.00");
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !document.querySelector("#mediaViewer").open,
    );
    assert.equal(await search.inputValue(), "7.00");
    assert.equal(await page.locator("#mediaViewerBody").textContent(), "");

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
      "UI experience: IME, search shortcuts/clearing, selection semantics, year position, scroll/disclosure/focus restoration, RPG filter, idle transitions and media Escape/fullscreen passed offline; no games or saved bindings.",
    );
  } finally {
    await electron.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
