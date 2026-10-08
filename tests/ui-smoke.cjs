// Reproducible UI-only check: no installed games, no launch or file dialogs.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { _electron } = require("playwright");
(async () => {
  const root = path.resolve(__dirname, ".."),
    out = path.join(root, "test-results");
  await fs.mkdir(out, { recursive: true });
  const data = await fs.mkdtemp(path.join(out, "ui-offline-"));
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
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (/^https?:/.test(r.url())) external.push(r.url());
    });
    await page.waitForSelector('[data-testid="nav-timeline"]', {
      timeout: 45000,
    });
    await page.context().setOffline(true);
    await page.reload();
    await page.waitForSelector('[data-testid="nav-timeline"]');
    const s = await page.evaluate(() => window.chronicle.snapshot());
    assert.equal(s.launcherVersion, require("../package.json").version);
    assert.equal(s.entries.filter((e) => e.installed).length, 0);
    assert.equal(s.entries.length, 19);
    assert.ok(s.entries.some((entry) => entry.id === "7.35d"));
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    const shownIds = await page
      .locator("[data-history]")
      .evaluateAll((rows) => rows.map((row) => row.dataset.history));
    assert.deepEqual(
      shownIds,
      s.history.entries.map((h) => h.id),
    );
    assert.equal(s.collection.sources.length, 32);
    assert.equal(
      s.history.entries.filter((h) => h.availability === "available").length,
      32,
    );
    await page.locator('[data-testid="search"]').fill("7.20c");
    await page.locator('[data-history="patch-7.20c"]').click();
    assert.match(await page.locator(".inspector").textContent(), /有可用版本/);
    assert.equal(await page.locator("[data-launch]").count(), 0);
    assert.equal(await page.locator(".inspector img").count(), 0);
    await page.locator('[data-download-source="patch-7.20c"]').click();
    assert.equal(
      await electron.evaluate(({ clipboard }) => clipboard.readText()),
      s.collection.sources.find((r) => r.historyId === "patch-7.20c").sourceUrl,
    );
    await page.locator('[data-testid="search"]').fill("");
    await page.locator('[data-filter="available"]').click();
    assert.equal(await page.locator(".version-row").count(), 32);
    await page.locator('[data-filter="owned"]').click();
    assert.equal(await page.locator(".version-row").count(), 0);
    await page.locator('[data-filter="uncollected"]').click();
    assert.equal(
      await page.locator(".version-row").count(),
      s.history.entries.length - 32,
    );
    await page.locator('[data-filter="all"]').click();
    // Selecting a record keeps its surrounding history in place and unfolded.
    const top = await page
      .locator(".client-updates")
      .first()
      .evaluate((group) => {
        group.open = true;
        const content = document.querySelector("#content");
        content.scrollTop = 600;
        const top = content.scrollTop;
        group.querySelector("[data-history]").click();
        return top;
      });
    assert.equal(
      await page.locator("#content").evaluate((e) => e.scrollTop),
      top,
    );
    assert.equal(
      await page
        .locator(".client-updates")
        .first()
        .evaluate((e) => e.open),
      true,
    );
    await page.locator('[data-testid="search"]').fill("6.80c");
    assert.equal(await page.locator(".version-row").count(), 1);
    await page.locator('[data-select="6.80c"]').click();
    assert.equal(await page.locator("[data-launch]").count(), 0);
    assert.equal(await page.locator(".media-gallery").count(), 0);
    await page.locator('[data-testid="search"]').fill("7.41f");
    assert.equal(await page.locator(".version-row").count(), 1);
    await page.locator('[data-history="patch-7.41f"]').click();
    assert.equal(await page.locator("[data-launch]").count(), 0);
    assert.equal(await page.locator(".inspector img").count(), 0);
    assert.equal(await page.locator("[data-history-source]").count(), 1);
    await page.locator('[data-testid="nav-rpg"]').click();
    const maps = [
        ...new Map(
          s.entries.flatMap((entry) =>
            entry.events.map((event) => [event.id, event]),
          ),
        ).values(),
      ],
      officialCount = maps.filter(
        (event) => event.category === "official",
      ).length,
      communityCount = maps.filter(
        (event) => event.category === "community",
      ).length;
    assert.equal(await page.locator(".rpg").count(), maps.length);
    assert.equal(
      await page.locator('[data-rpg-group="official"] .rpg').count(),
      officialCount,
    );
    assert.equal(
      await page.locator('[data-rpg-group="community"] .rpg').count(),
      communityCount,
    );
    await page.locator('[data-filter="official"]').click();
    assert.equal(await page.locator(".rpg").count(), officialCount);
    assert.equal(await page.locator('[data-rpg-group="community"]').count(), 0);
    await page.locator('[data-filter="community"]').click();
    assert.equal(await page.locator(".rpg").count(), communityCount);
    assert.equal(await page.locator('[data-rpg-group="official"]').count(), 0);
    await page.locator('.rpg[data-event="epic-boss-fight"]').click();
    assert.equal(await page.locator(".rpg").count(), communityCount);
    assert.equal(
      await page.locator('[data-filter="community"]').getAttribute("class"),
      "chip active",
    );
    await page.locator('[data-filter="all"]').click();
    await page.locator('[data-event="nian2014"]').first().click();
    assert.equal(await page.locator('[data-launch="nian2014"]').count(), 0);
    assert.equal(await page.locator(".media-gallery").count(), 0);
    await page.locator('[data-testid="nav-room"]').click();
    assert.equal(await page.locator('[data-action="host"]').isDisabled(), true);
    await page.locator('[data-testid="nav-library"]').click();
    assert.equal(await page.locator('[data-bind="2011"]').isEnabled(), true);
    await page.locator('[data-testid="search"]').fill("6.83");
    assert.equal(await page.locator(".library-client").count(), 1);
    await page.locator('.library-client[data-select="6.83"]').click();
    assert.equal(await page.locator(".detail-version").textContent(), "6.83");
    assert.equal(
      (await page.evaluate(() => window.chronicle.status())).sessions.length,
      0,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(
      "Offline UI: four views, full update search, unowned media/launch gating, sandbox and zero external requests passed.",
    );
  } finally {
    await electron.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
