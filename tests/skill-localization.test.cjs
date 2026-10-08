const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { generate, TARGET } = require("../src/backend/skill-localization.cjs");

const localizationPath = (kind, language) =>
  `resource/localization/${kind}_${language}.txt`;
const definitionPath = "scripts/npc/npc_abilities.txt";
const itemPath = "scripts/npc/items.txt";
const abilities = Buffer.from(
  '"DOTAAbilities" { "Version" "1"\n' +
    '// A comment with { "comment_only" { } }\n' +
    '"sven_storm_bolt" { "QuotedBraces" "{ text }" ' +
    '"AbilitySpecial" { "01" { "radius" "250" } } }\n' +
    '"test_description" { "AbilityType" "DOTA_ABILITY_TYPE_BASIC" }\n' +
    '"unlocalized" { "MaxLevel" "1" } }',
);
const items = Buffer.from(
  '"DOTAAbilities" { "item_blink" { "MaxLevel" "1" } }',
);

function utf16(text, bom = true) {
  return Buffer.concat([
    bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0),
    Buffer.from(text, "utf16le"),
  ]);
}

function sources() {
  return [
    [
      localizationPath("abilities", "english"),
      utf16(
        '"lang" { "Tokens" {\n' +
          '"DOTA_Tooltip_ability_sven_storm_bolt" "Test Bolt"\n' +
          '"DOTA_Tooltip_ability_test_description" "Legitimate Name"\n' +
          '"DOTA_Tooltip_ability_sven_storm_bolt_description" "IGNORE DESCRIPTION"\n' +
          '"DOTA_Tooltip_ability_sven_storm_bolt_radius" "IGNORE PARAMETER"\n' +
          '"DOTA_Tooltip_ability_sven_storm_bolt_lore" "IGNORE LORE"\n' +
          '"DOTA_Tooltip_ability_radius" "IGNORE NESTED KEY"\n' +
          '"DOTA_Tooltip_ability_comment_only" "IGNORE COMMENT"\n' +
          '"[english]DOTA_Tooltip_ability_sven_storm_bolt" "IGNORE OVERRIDE"\n' +
          "} }",
      ),
    ],
    [
      localizationPath("abilities", "schinese"),
      utf16(
        '"lang" { "Tokens" {\n' +
          '"DOTA_Tooltip_ability_sven_storm_bolt" "测试之拳"\n' +
          '"DOTA_Tooltip_ability_sven_storm_bolt_description" "不应收入的技能说明"\n' +
          "} }",
      ),
    ],
    [
      localizationPath("items", "english"),
      utf16('"DOTA_Tooltip_ability_item_blink" "Test Blink"\n'),
    ],
    [
      localizationPath("items", "schinese"),
      utf16(
        '"DOTA_Tooltip_ability_item_blink_description" "不应收入的物品说明"\n',
      ),
    ],
    [definitionPath, abilities],
    [itemPath, items],
  ];
}

// Synthetic original-style VPK fixtures, never Valve resource contents.
async function writeVpk(
  root,
  { version = 2, embedded = false, preload = 7, rows = sources(), alter } = {},
) {
  const folder = path.join(root, "game/dota");
  await fs.mkdir(folder, { recursive: true });
  const groups = new Map();
  for (const [file, bytes] of rows) {
    const extension = path.posix.extname(file).slice(1);
    const directory = path.posix.dirname(file);
    if (!groups.has(extension)) groups.set(extension, new Map());
    const directories = groups.get(extension);
    if (!directories.has(directory)) directories.set(directory, []);
    directories
      .get(directory)
      .push([path.posix.basename(file, "." + extension), file, bytes]);
  }
  const tree = [],
    data = [];
  let offset = 0;
  for (const [extension, directories] of groups) {
    tree.push(Buffer.from(extension + "\0"));
    for (const [directory, entries] of directories) {
      tree.push(Buffer.from(directory + "\0"));
      for (const [name, file, bytes] of entries) {
        const pre = Math.min(preload, bytes.length);
        const entry = Buffer.alloc(18);
        entry.writeUInt16LE(pre, 4);
        entry.writeUInt16LE(embedded ? 0x7fff : 0, 6);
        entry.writeUInt32LE(offset, 8);
        entry.writeUInt32LE(bytes.length - pre, 12);
        entry.writeUInt16LE(65535, 16);
        if (alter) alter(entry, file);
        tree.push(Buffer.from(name + "\0"), entry, bytes.subarray(0, pre));
        data.push(bytes.subarray(pre));
        offset += bytes.length - pre;
      }
      tree.push(Buffer.from([0]));
    }
    tree.push(Buffer.from([0]));
  }
  tree.push(Buffer.from([0]));
  const directory = Buffer.concat(tree),
    payload = Buffer.concat(data),
    header = Buffer.alloc(version === 1 ? 12 : 28);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(directory.length, 8);
  if (version === 2) header.writeUInt32LE(embedded ? payload.length : 0, 12);
  await fs.writeFile(
    path.join(folder, "pak01_dir.vpk"),
    Buffer.concat([header, directory, embedded ? payload : Buffer.alloc(0)]),
  );
  if (!embedded)
    await fs.writeFile(path.join(folder, "pak01_000.vpk"), payload);
  return { header, tree: directory, data: payload };
}

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "chronicle-skill-names-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("UTF8 KV contains exact native IDs, selected language and bilingual search", async (t) => {
  const root = await fixture(t);
  await writeVpk(root);
  const bytes = await generate(root, "schinese"),
    text = bytes.toString("utf8");
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(
    TARGET,
    "game/dota/scripts/npc/chronicle_skill_localization_v1.txt",
  );
  assert.match(text, /^"ChronicleSkillLocalization"\n\{/);
  assert.match(text, /"Tokens"[\s\S]*"sven_storm_bolt" "测试之拳"/);
  assert.match(
    text,
    /"SearchTokens"[\s\S]*"sven_storm_bolt" "Test Bolt 测试之拳"/,
  );
  assert.match(text, /"item_blink" "Test Blink"/);
  assert.match(text, /"test_description" "Legitimate Name"/);
  assert.doesNotMatch(
    text,
    /IGNORE|不应收入|DOTA_Tooltip|"radius"|"comment_only"/,
  );
  assert.equal((text.match(/^\t\t"/gm) || []).length, 6);
  const english = (await generate(root, "english")).toString("utf8");
  assert.match(english, /"Tokens"[\s\S]*"sven_storm_bolt" "Test Bolt"/);
  assert.match(english, /"SearchTokens"[\s\S]*测试之拳/);
  assert.equal((await generate(root, "russian")).toString(), english);
  await assert.rejects(generate(root, "invalid"), /语言无效/);
  await assert.rejects(generate("relative/client", "english"), /绝对路径/);
  await assert.rejects(fs.stat(path.join(root, TARGET)), { code: "ENOENT" });
});

test("VPK v1/v2 embedded and archive entries combine arbitrary preload byte splits", async (t) => {
  const root = await fixture(t);
  for (const version of [1, 2]) {
    for (const embedded of [false, true]) {
      await writeVpk(root, { version, embedded, preload: 7 });
      assert.match((await generate(root, "schinese")).toString(), /测试之拳/);
    }
  }
  await writeVpk(root, { embedded: true, preload: 0 });
  assert.match((await generate(root)).toString(), /Test Blink/);
});

test("loose definition wins over packed definitions; only missing definitions use VPK", async (t) => {
  const root = await fixture(t);
  const rows = sources().filter(([name]) => name !== definitionPath);
  await writeVpk(root, { rows });
  await fs.mkdir(path.join(root, "game/dota/scripts/npc"), { recursive: true });
  await fs.writeFile(path.join(root, "game/dota", definitionPath), abilities);
  assert.match((await generate(root)).toString(), /Test Bolt/);
  await fs.writeFile(
    path.join(root, "game/dota", definitionPath),
    '"DOTAAbilities" { "another_skill" { "MaxLevel" "1" } }',
  );
  assert.doesNotMatch(
    (await generate(root)).toString(),
    /Test Bolt|Legitimate Name/,
  );
});

test("KV names escape quotes and slashes without permitting extra keys or newline injection", async (t) => {
  const root = await fixture(t),
    rows = sources();
  rows[0][1] = utf16(
    '"DOTA_Tooltip_ability_sven_storm_bolt" "Bolt \\"quoted\\" \\\\ path\\nsecond"\n'.replace(
      /\\\\"/g,
      '\\"',
    ),
  );
  await writeVpk(root, { rows });
  const text = (await generate(root)).toString();
  assert.match(text, /"sven_storm_bolt" "Bolt \\"quoted\\" \\\\ path second"/);
  assert.doesNotMatch(text, /path\nsecond/);
});

test("UTF16LE names support BOM and reject odd bytes, BE and invalid surrogates", async (t) => {
  const root = await fixture(t),
    rows = sources();
  rows[1][1] = utf16(
    '"DOTA_Tooltip_ability_sven_storm_bolt" "测试之拳"\n',
    false,
  );
  await writeVpk(root, { rows });
  assert.match((await generate(root, "schinese")).toString(), /测试之拳/);
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.from([0xfe, 0xff, 0, 65]),
    Buffer.from([0xff, 0xfe, 0, 0xd8]),
  ]) {
    rows[1][1] = bytes;
    await writeVpk(root, { rows });
    await assert.rejects(generate(root));
  }
});

test("verified Labyrinth profile accepts bounded UTF8 BOM and no-BOM names without relaxing 7.22", async (t) => {
  const root = await fixture(t);
  for (const bom of [true, false]) {
    const rows = sources().map(([name, bytes]) => [name, bytes]);
    for (let index = 0; index < 4; index++) {
      const text = new TextDecoder("utf-16le", { fatal: true }).decode(
        rows[index][1],
      );
      rows[index][1] = Buffer.concat([
        bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
        Buffer.from(text, "utf8"),
      ]);
    }
    await writeVpk(root, { rows });
    const text = (await generate(root, "schinese", "727c-aghanim-v1")).toString(
      "utf8",
    );
    assert.match(text, /"Tokens"[\s\S]*"sven_storm_bolt" "测试之拳"/);
    assert.match(
      text,
      /"SearchTokens"[\s\S]*"sven_storm_bolt" "Test Bolt 测试之拳"/,
    );
    assert.doesNotMatch(text, /IGNORE|不应收入|DOTA_Tooltip/);
    await assert.rejects(generate(root, "schinese"), /UTF-16LE/);
  }
  await assert.rejects(
    generate(root, "english", "unregistered-profile"),
    /白名单/,
  );
});

test("Labyrinth rejects malformed UTF8, NUL, BE and marked malformed UTF16 without encoding fallback", async (t) => {
  const root = await fixture(t);
  const rows = sources();
  for (const bytes of [
    Buffer.from([0xef, 0xbb, 0xbf, 0xff]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from('"DOTA_Tooltip_ability_sven_storm_bolt" "Bolt\0bad"\n', "utf8"),
    Buffer.from([0xff, 0xfe, 0x22]),
    Buffer.from([0xff, 0xfe, 0, 0xd8]),
    Buffer.from([0xfe, 0xff, 0, 0x22]),
  ]) {
    rows[0][1] = bytes;
    await writeVpk(root, { rows });
    await assert.rejects(generate(root, "english", "727c-aghanim-v1"));
  }
});

test("bounded VPK trees and sources reject oversized, duplicate, unsafe and truncated entries", async (t) => {
  const root = await fixture(t),
    file = path.join(root, "game/dota/pak01_dir.vpk");
  await writeVpk(root);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(64 * 1024 ** 2 + 1, 8);
  await fs.writeFile(file, header);
  await assert.rejects(generate(root), /目录大小无效/);
  await writeVpk(root, {
    alter(entry, name) {
      if (name === localizationPath("abilities", "english"))
        entry.writeUInt32LE(8 * 1024 ** 2 + 1, 12);
    },
  });
  await assert.rejects(generate(root), /资源大小或分块无效/);
  await writeVpk(root, {
    alter(entry, name) {
      if (name === localizationPath("abilities", "english"))
        entry.writeUInt32LE(0xfffffff0, 8);
    },
  });
  await assert.rejects(generate(root), /分块.*截断/);
  await writeVpk(root, { rows: [...sources(), sources()[0]] });
  await assert.rejects(generate(root), /资源重复/);
  await writeVpk(root, {
    rows: [...sources(), ["../unsafe.txt", Buffer.from("x")]],
  });
  await assert.rejects(generate(root), /不安全.*路径/);
  const valid = await writeVpk(root);
  await fs.writeFile(
    file,
    Buffer.concat([valid.header, valid.tree.subarray(0, -1)]),
  );
  await assert.rejects(generate(root), /目录截断/);
});

test("VPK v2 embedded ranges cannot read metadata after the declared data section", async (t) => {
  const root = await fixture(t);
  const built = await writeVpk(root, { embedded: true });
  built.header.writeUInt32LE(0, 12);
  await fs.writeFile(
    path.join(root, "game/dota/pak01_dir.vpk"),
    Buffer.concat([built.header, built.tree, built.data]),
  );
  await assert.rejects(generate(root), /超出数据区/);
});

test("unrelated entries are not read; long names and malformed native definitions are rejected", async (t) => {
  const root = await fixture(t);
  await writeVpk(root, {
    rows: [...sources(), ["resource/unrelated.txt", Buffer.from("ignored")]],
    alter(entry, name) {
      if (name === "resource/unrelated.txt") {
        entry.writeUInt16LE(12, 6);
        entry.writeUInt32LE(0xfffffff0, 8);
        entry.writeUInt32LE(0xfffffff0, 12);
      }
    },
  });
  assert.match((await generate(root)).toString(), /Test Bolt/);
  const rows = sources();
  rows[0][1] = utf16(
    `"DOTA_Tooltip_ability_sven_storm_bolt" "${"x".repeat(257)}"\n`,
  );
  await writeVpk(root, { rows });
  await assert.rejects(generate(root), /名称过长/);
  rows[0][1] = sources()[0][1];
  for (const source of [
    '"OtherRoot" { "sven_storm_bolt" { } }',
    '"DOTAAbilities" { "sven_storm_bolt" {',
    '"DOTAAbilities" { "sven_storm_bolt" { "unclosed',
    '"DOTAAbilities" { /* unclosed',
  ]) {
    rows[4][1] = Buffer.from(source);
    await writeVpk(root, { rows });
    await assert.rejects(generate(root), /定义/);
  }
});

test("linked client directories and archive chunks are refused before resource reads", async (t) => {
  const root = await fixture(t);
  await writeVpk(root);
  const link = path.join(root, "linked-client");
  await fs.symlink(
    root,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(generate(link), /符号链接或目录联接/);
  await fs.rm(link);
  const archive = path.join(root, "game/dota/pak01_000.vpk"),
    real = path.join(root, "real-archive.vpk");
  await fs.rename(archive, real);
  try {
    await fs.symlink(real, archive, "file");
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES"].includes(error.code)
    ) {
      t.diagnostic(
        "File symlinks unavailable; the parent-junction guard was verified.",
      );
      return;
    }
    throw error;
  }
  await assert.rejects(generate(root), /符号链接或目录联接/);
});
