// Launcher UI regression with isolated data and in-memory IPC recorders.
// No native game, directory picker, user configuration or network operation.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { _electron } = require("playwright");

(async () => {
  const root = path.resolve(__dirname, ".."),
    out = path.join(root, "test-results");
  await fs.mkdir(out, { recursive: true });
  const data = await fs.mkdtemp(path.join(out, "skill-editor-ui-")),
    app = await _electron.launch({
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
    await page.waitForSelector('[data-testid="nav-library"]', {
      timeout: 45000,
    });
    await page.context().setOffline(true);
    const snapshot = await page.evaluate(() => window.chronicle.snapshot());
    assert.equal(snapshot.entries.filter((entry) => entry.installed).length, 0);
    assert.deepEqual(snapshot.sessions, []);
    assert.deepEqual(
      snapshot.entries
        .filter((entry) => entry.skillEditor)
        .map((entry) => entry.id),
      ["7.22"],
    );
    await page.locator('[data-testid="nav-library"]').click();
    await page.locator('.library-client[data-select="7.22"]').click();
    const button = page.locator('[data-launch="skills"]'),
      hint = page.locator('[data-testid="skill-editor-guidance"]');
    assert.equal(await button.count(), 1);
    assert.equal(
      await button.isDisabled(),
      true,
      "unbound clients cannot start skills",
    );
    assert.match(await hint.innerText(), /原生试玩.*自动载入/);

    const fixture = structuredClone(snapshot);
    for (const entry of fixture.entries) {
      if (["7.22", "7.00", "7.27c"].includes(entry.id)) {
        entry.installed = true;
        entry.menuAvailable = true;
        entry.root = path.join(data, "unlaunchable-" + entry.id);
      }
      if (entry.id === "7.27c")
        for (const event of entry.events)
          event.available = !event.launchDisabledReason;
      if (entry.id === "2011") entry.menuAvailable = true;
    }
    await app.evaluate(({ ipcMain }, value) => {
      const harness = {
        fixture: value,
        launches: [],
        stops: [],
        forbidden: [],
      };
      ipcMain.__chronicleSkillLaunchUi = harness;
      for (const name of ["snapshot", "status", "launch", "stop"])
        ipcMain.removeHandler("chronicle:" + name);
      ipcMain.handle("chronicle:snapshot", () => ({ ok: true, value }));
      ipcMain.handle("chronicle:status", () => ({
        ok: true,
        value: {
          sessions: value.sessions,
          configRevision: value.configRevision,
        },
      }));
      ipcMain.handle("chronicle:launch", (_event, input) => {
        if (!(
          (input.id === "7.22" && input.mode === "skills") ||
          (input.id === "7.27c" && input.mode === "aghanim1-skills")
        ))
          throw Error("Unexpected fixture launch");
        harness.launches.push(input);
        value.sessions = [
          {
            id: "fixture-skills-session",
            version: input.id,
            mode: input.mode,
            type: "client",
            stage: "running",
            skillEditorPhase:
              input.mode === "skills" ? "waiting-demo" : "waiting-labyrinth",
          },
        ];
        return { ok: true, value: value.sessions[0] };
      });
      ipcMain.handle("chronicle:stop", (_event, input) => {
        if (input.id !== "fixture-skills-session")
          throw Error("Unexpected fixture stop");
        harness.stops.push(input);
        value.sessions = [];
        return { ok: true, value: true };
      });
      for (const name of [
        "bind",
        "scan",
        "bindArchives",
        "package",
        "prepare",
        "host",
        "join",
        "fillBots",
        "saveRoom",
        "saveLaunchOptions",
        "openFolder",
        "importMedia",
        "copy",
      ]) {
        ipcMain.removeHandler("chronicle:" + name);
        ipcMain.handle("chronicle:" + name, () => {
          harness.forbidden.push(name);
          throw Error("Forbidden operation in skill UI test: " + name);
        });
      }
    }, fixture);
    await page.locator('[data-action="refresh"]').first().click();
    await page.waitForFunction(
      () => !document.querySelector('[data-launch="skills"]')?.disabled,
    );
    await button.click();
    await page.waitForSelector('[data-testid="skill-editor-phase"]');
    assert.match(
      await page.locator('[data-testid="skill-editor-phase"]').innerText(),
      /主菜单.*原生试玩/,
    );
    assert.match(
      await page.locator("#sessionList").innerText(),
      /7\.22 · 技能编辑器/,
    );
    assert.equal(await button.isDisabled(), true);
    assert.equal(await page.locator('[data-launch="bots"]').isDisabled(), true);
    for (const [phase, text] of [
      ["loading", "正在加载技能编辑器"],
      ["ready", "面板已请求打开"],
      ["error", "游戏仍可继续使用"],
    ]) {
      await app.evaluate(({ ipcMain }, value) => {
        const session = ipcMain.__chronicleSkillLaunchUi.fixture.sessions[0];
        session.skillEditorPhase = value;
        session.skillEditorError =
          value === "error" ? "Fixture panel failed <safe>" : "";
      }, phase);
      await page.waitForFunction(
        (text) =>
          document
            .querySelector('[data-testid="skill-editor-phase"]')
            ?.textContent.includes(text),
        text,
        { timeout: 10000 },
      );
      assert.equal(
        await button.isDisabled(),
        true,
        "active game remains owned after a tool failure",
      );
      assert.equal(
        await page.locator('[data-stop="fixture-skills-session"]').count(),
        1,
      );
    }
    assert.equal(
      await page.locator('[data-testid="skill-editor-error"]').innerText(),
      "Fixture panel failed <safe>",
    );
    await page.locator('[data-stop="fixture-skills-session"]').click();
    await page.locator('#confirm button[value="stop"]').click();
    await page.waitForFunction(
      () => !document.querySelector('[data-launch="skills"]')?.disabled,
      undefined,
      { timeout: 10000 },
    );
    // Poll must keep this special route enabled instead of treating it as an absent event.
    await page.waitForTimeout(3400);
    assert.equal(await button.isDisabled(), false);

    await page.locator('.library-client[data-select="7.00"]').click();
    assert.equal(
      await button.count(),
      0,
      "other clients do not inherit the tool",
    );
    await page.locator('.library-client[data-select="2011"]').click();
    assert.equal(await button.count(), 0);
    assert.equal(await page.locator('[data-launch="menu"]').count(), 1);
    assert.equal(await page.locator('[data-launch="bots"]').count(), 0);
    await page.locator('[data-testid="nav-room"]').click();
    assert.equal(
      await page.locator('#roomMode option[value="skills"]').count(),
      0,
    );
    await page.locator('[data-testid="nav-rpg"]').click();
    assert.equal(
      await button.count(),
      0,
      "map details retain their own launch route",
    );

    await page.locator('.rpg[data-event="aghanim1"]').click();
    const labyrinth = page.locator('[data-launch="aghanim1-skills"]');
    assert.equal(await labyrinth.count(), 1);
    assert.equal(await labyrinth.isDisabled(), false);
    assert.match(
      await page
        .locator('[data-testid="labyrinth-skill-editor-guidance"]')
        .innerText(),
      /单人作弊模式.*原有技能与碎片保留/,
    );
    await page.waitForTimeout(3400);
    assert.equal(
      await labyrinth.isDisabled(),
      false,
      "poll retains the derived official map route",
    );
    await labyrinth.click();
    await page.waitForSelector('[data-testid="skill-editor-phase"]');
    assert.match(
      await page.locator('[data-testid="skill-editor-phase"]').innerText(),
      /锁定迷宫英雄/,
    );
    assert.match(
      await page.locator("#sessionList").innerText(),
      /7\.27c · 迷宫 · 技能编辑器/,
    );
    assert.equal(await labyrinth.isDisabled(), true);
    await page.locator('[data-stop="fixture-skills-session"]').click();
    await page.locator('#confirm button[value="stop"]').click();
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-launch="aghanim1-skills"]')?.disabled,
    );
    await page.locator('.rpg[data-event="dota-mijing"]').click();
    assert.equal(
      await labyrinth.count(),
      0,
      "other maps on the same client do not inherit the editor",
    );
    await page.locator('[data-testid="nav-room"]').click();
    assert.equal(
      await page.locator('#roomMode option[value="aghanim1-skills"]').count(),
      0,
    );

    const records = await app.evaluate(({ ipcMain }) => {
      const h = ipcMain.__chronicleSkillLaunchUi;
      return { launches: h.launches, stops: h.stops, forbidden: h.forbidden };
    });
    assert.deepEqual(records.launches, [
      { id: "7.22", mode: "skills" },
      { id: "7.27c", mode: "aghanim1-skills" },
    ]);
    assert.deepEqual(records.stops, [
      { id: "fixture-skills-session" },
      { id: "fixture-skills-session" },
    ]);
    assert.deepEqual(records.forbidden, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const result = {
      passed: true,
      version: fixture.launcherVersion,
      checks: [
        "unbound gating",
        "canonical skills request",
        "native-demo guidance",
        "localized phases",
        "tool error keeps game owned",
        "stop releases launch buttons",
        "poll preserves skills route",
        "no room/map/menu-only inheritance",
        "official Labyrinth route and guarded single-player guidance",
        "Labyrinth polling, state, stop, and no other-map inheritance",
        "no external requests or page errors",
      ],
      records,
    };
    await fs.writeFile(
      path.join(out, "skill-editor-launch-ui.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
