// Compile only Chronicle's original 7.27c Labyrinth UI/Lua. Valve tools,
// configuration and game resources remain private and are never distributed.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { inside, noLinks } = require("../src/backend/files.cjs");

const PROJECT = path.resolve(__dirname, "..");
const BUILD = 4397;
const COMPILER_DLL_SHA =
  "81139d9a49dae0b36c33087aa9c19879bdfecceb1fc6f2f6ce0d1249c977cbd1";
const GENERIC_LOADER_SHA =
  "b8ab1d1a410b70845d69ef5776913d5016248359fbf80a3bb23b92989dbafbdd";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function readOriginal(file) {
  await noLinks(file);
  if (!(await fs.stat(file)).isFile())
    throw Error("Expected an original file.");
  return fs.readFile(file);
}

async function main() {
  const argument = process.argv[2];
  if (!argument || !path.isAbsolute(argument))
    throw Error("Supply an absolute local 7.27c / build 4397 client folder.");
  const client = path.resolve(argument);
  await noLinks(client);
  const inf = (
    await readOriginal(inside(client, "game/dota/steam.inf"))
  ).toString("utf8");
  if (
    !/^ClientVersion=4397\s*$/m.test(inf) ||
    !/^ServerVersion=4397\s*$/m.test(inf)
  )
    throw Error("Requires matching 7.27c client/server build 4397.");
  const originalBin = inside(client, "game/bin/win64");
  const compilerDll = inside(originalBin, "resourcecompiler.dll");
  if (hash(await readOriginal(compilerDll)) !== COMPILER_DLL_SHA)
    throw Error("The 7.27c compiler implementation fingerprint changed.");

  let loader = inside(originalBin, "resourcecompiler.exe");
  try {
    await fs.access(loader);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const legacyArgument = process.argv[3];
    if (!legacyArgument || !path.isAbsolute(legacyArgument))
      throw Error(
        "This client lacks the compiler loader; supply the verified 7.22 client as argument 2.",
      );
    const legacyClient = path.resolve(legacyArgument);
    const legacyInf = (
      await readOriginal(inside(legacyClient, "game/dota/steam.inf"))
    ).toString("utf8");
    if (!/^ClientVersion=3504\s*$/m.test(legacyInf))
      throw Error(
        "Fallback loader must come from the verified 7.22 / build 3504 tools.",
      );
    loader = inside(legacyClient, "game/bin/win64/resourcecompiler.exe");
    if (hash(await readOriginal(loader)) !== GENERIC_LOADER_SHA)
      throw Error("The generic compiler loader fingerprint changed.");
  }

  // Relative source mounts require a private staging directory on the same drive.
  const build = path.join(
    path.parse(client).root,
    ".chronicle-build/skill-editor-7.27c",
  );
  await noLinks(build);
  const gameRoot = inside(build, "game");
  const game = inside(build, "game/dota");
  const bin = inside(build, "game/bin/win64");
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(game, { recursive: true });
  const provenance = [];
  async function stage(original, destination) {
    const bytes = await readOriginal(original);
    await noLinks(destination);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
    provenance.push({
      file: path.relative(build, destination).replaceAll("\\", "/"),
      sha256: hash(bytes),
    });
  }
  await stage(loader, inside(bin, "resourcecompiler.exe"));
  for (const entry of await fs.readdir(originalBin, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw Error("Compiler dependency directory contains a link.");
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll"))
      await stage(inside(originalBin, entry.name), inside(bin, entry.name));
  }
  const originalConfig = inside(client, "game/bin");
  for (const entry of await fs.readdir(originalConfig, {
    withFileTypes: true,
  })) {
    if (entry.isSymbolicLink())
      throw Error("Compiler configuration directory contains a link.");
    if (entry.isFile())
      await stage(
        inside(originalConfig, entry.name),
        inside(build, "game/bin/" + entry.name),
      );
  }
  const installed = ["dota", "core"].map((name) =>
    path
      .relative(gameRoot, inside(client, "game/" + name))
      .replaceAll("\\", "/"),
  );
  const gameInfo = inside(game, "gameinfo.gi");
  await noLinks(gameInfo);
  await fs.writeFile(
    gameInfo,
    '"GameInfo" { game "Chronicle original Labyrinth UI compiler" FileSystem { SteamAppId 570 SearchPaths { Game "dota" ' +
      installed.map((relative) => 'Game "' + relative + '"').join(" ") +
      ' Mod "dota" } } Engine2 { PanoramaUIClientFromClient 1 } }\n',
  );
  const provenanceFile = inside(build, "compiler-provenance.json");
  await noLinks(provenanceFile);
  await fs.writeFile(
    provenanceFile,
    JSON.stringify({ clientBuild: BUILD, files: provenance }, null, 2) + "\n",
  );

  const author = inside(PROJECT, "tools/legacy-ability/7.27c");
  const payload = inside(PROJECT, "resources/skill-editor/7.27c");
  await noLinks(payload);
  const files = [];
  for (const [kind, sourceExt, engineExt] of [
    ["scripts", "js", "vjs"],
    ["styles", "css", "vcss"],
    ["layout", "xml", "vxml"],
  ]) {
    const base = `${kind}/custom_game/chronicle_labyrinth_ability_editor`;
    const source = inside(author, `ui/${base}.${sourceExt}`);
    const staged = inside(build, `content/dota/panorama/${base}.${engineExt}`);
    await noLinks(staged);
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.writeFile(staged, await readOriginal(source));
    const result = spawnSync(
      inside(bin, "resourcecompiler.exe"),
      [
        "-nop4",
        "-f",
        "-game",
        game,
        "-contentroot",
        inside(build, "content"),
        "-outroot",
        gameRoot,
        "-i",
        staged,
      ],
      {
        cwd: bin,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 8 * 1024 ** 2,
        windowsHide: true,
        env: {
          ...process.env,
          PATH: originalBin + path.delimiter + process.env.PATH,
        },
      },
    );
    if (result.error || result.status !== 0)
      throw Error(result.error?.message || result.stdout + result.stderr);
    const relative = `panorama/${base}.${engineExt}_c`;
    const bytes = await readOriginal(inside(build, "game/dota/" + relative));
    if (
      bytes.length < 16 ||
      bytes.readUInt16LE(4) !== 12 ||
      bytes.readUInt16LE(6) !== 3
    )
      throw Error(`Unexpected 7.27c Panorama resource version for ${kind}.`);
    const output = inside(payload, relative);
    await noLinks(output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, bytes);
    files.push({
      source: relative,
      target: "game/dota/" + relative,
      sha256: hash(bytes),
    });
    console.log(`Compiled ${path.basename(relative)} (${bytes.length} bytes)`);
  }
  const lua = "chronicle_labyrinth_skill_editor_v1.lua";
  const luaBytes = await readOriginal(inside(author, lua));
  const outputLua = inside(payload, lua);
  await noLinks(outputLua);
  await fs.writeFile(outputLua, luaBytes);
  files.push({
    source: lua,
    target: "game/dota/scripts/vscripts/" + lua,
    sha256: hash(luaBytes),
  });
  const manifest = inside(payload, "manifest.json");
  await noLinks(manifest);
  await fs.writeFile(
    manifest,
    JSON.stringify(
      {
        schema: 1,
        clientBuild: BUILD,
        profile: "727c-aghanim-v1",
        files: files.sort((a, b) => a.target.localeCompare(b.target)),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Original Labyrinth skill editor payload ready; private compiler staging is external to the payload.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
