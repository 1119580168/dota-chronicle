// Compile only original Chronicle Panorama sources with the user's 7.22 tools.
// Compiler/game data stay external; release payload contains our four files.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
async function main() {
  const client = path.resolve(
    process.argv[2] || process.env.CHRONICLE_722_CLIENT || "",
  );
  if (!process.argv[2] && !process.env.CHRONICLE_722_CLIENT)
    throw Error("Supply the local 7.22 client folder.");
  const inf = await fs.readFile(
    path.join(client, "game/dota/steam.inf"),
    "utf8",
  );
  if (!/^ClientVersion=3504\s*$/m.test(inf))
    throw Error("Requires 7.22 / build 3504 tools.");
  const compiler = path.join(client, "game/bin/win64/resourcecompiler.exe");
  await fs.access(compiler);
  const build = path.join(root, "local/skill-editor-build");
  const payload = path.join(root, "resources/skill-editor/7.22");
  const files = [];
  for (const [kind, sourceExt, engineExt] of [
    ["scripts", "js", "vjs"],
    ["styles", "css", "vcss"],
    ["layout", "xml", "vxml"],
  ]) {
    const base = `${kind}/custom_game/chronicle_ability_editor`;
    const source = path.join(
      root,
      "tools/legacy-ability/ui",
      `${base}.${sourceExt}`,
    );
    const staged = path.join(
      build,
      "content/dota/panorama",
      `${base}.${engineExt}`,
    );
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.copyFile(source, staged);
    const result = spawnSync(
      compiler,
      [
        "-nop4",
        "-f",
        "-game",
        path.join(client, "game/dota"),
        "-contentroot",
        path.join(build, "content"),
        "-outroot",
        path.join(build, "game"),
        "-i",
        staged,
      ],
      {
        cwd: path.dirname(compiler),
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0)
      throw Error(result.error?.message || result.stdout + result.stderr);
    const relative = `panorama/${base}.${engineExt}_c`;
    const bytes = await fs.readFile(path.join(build, "game/dota", relative));
    if (bytes.readUInt16LE(4) !== 12 || bytes.readUInt16LE(6) !== 3)
      throw Error("Unexpected Panorama resource version.");
    await fs.mkdir(path.dirname(path.join(payload, relative)), {
      recursive: true,
    });
    await fs.writeFile(path.join(payload, relative), bytes);
    files.push({
      source: relative,
      target: `game/dota/${relative}`,
      sha256: hash(bytes),
    });
    console.log(`Compiled ${path.basename(relative)} (${bytes.length} bytes)`);
  }
  const lua = "chronicle_skill_editor_v1.lua";
  const bytes = await fs.readFile(path.join(root, "tools/legacy-ability", lua));
  await fs.writeFile(path.join(payload, lua), bytes);
  files.push({
    source: lua,
    target: `game/dota/scripts/vscripts/${lua}`,
    sha256: hash(bytes),
  });
  await fs.writeFile(
    path.join(payload, "manifest.json"),
    JSON.stringify(
      {
        schema: 1,
        clientBuild: 3504,
        files: files.sort((a, b) => a.target.localeCompare(b.target)),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Original skill editor payload ready.");
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
