const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  exists,
  readJson,
  writeJson,
  hash,
  noLinks,
  inside,
} = require("./files.cjs");
const {
  inspect,
  inspectPackage,
  roomOptions,
  serverAddress,
} = require("./plans.cjs");
const { archiveSnapshot, readArchiveIndex } = require("./archives.cjs");
const { languageCode, detectLanguages } = require("./languages.cjs");
const {
  validateEventCatalog,
  catalogEntry,
  packageEvent,
} = require("./event-catalog.cjs");
async function inspectArchive(e, root) {
  if (e.playable || !e.archiveExe || !root || !path.isAbsolute(root))
    throw Error("没有可核验的历史档案目录");
  await noLinks(root);
  root = await fs.realpath(root);
  const exe = inside(root, e.archiveExe),
    inf = inside(root, e.steamInf);
  await noLinks(exe);
  await noLinks(inf);
  if (!(await fs.stat(exe)).isFile() || (await hash(inf)) !== e.sha)
    throw Error("档案构建不匹配");
  return { root };
}
class Library {
  constructor(catalog, data, sources = { entries: [] }) {
    validateEventCatalog(catalog);
    this.catalog = catalog;
    this.sources = sources;
    this.data = data;
    this.configFile = path.join(data, "library.json");
    this.config = {
      schema: 1,
      roots: {},
      packages: {},
      room: roomOptions(),
      launchOptions: {},
    };
  }
  async load() {
    let config = {
      schema: 1,
      roots: {},
      packages: {},
      room: roomOptions(),
      launchOptions: {},
    };
    const revision = await this.configRevision();
    let saved;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        saved = await readJson(this.configFile);
        break;
      } catch (error) {
        if (error.code === "ENOENT") break;
        if (["EACCES", "EPERM", "EBUSY"].includes(error.code) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          continue;
        }
        throw Error(
          "无法读取客户端绑定配置（" +
            (error.code || "格式错误") +
            "）：" +
            this.configFile,
        );
      }
    }
    if (saved !== undefined) {
      if (
        !saved ||
        typeof saved !== "object" ||
        Array.isArray(saved) ||
        (saved.roots &&
          (typeof saved.roots !== "object" || Array.isArray(saved.roots)))
      )
        throw Error("客户端绑定配置格式错误：" + this.configFile);
      config = {
        ...config,
        ...saved,
        roots: saved.roots || {},
        packages: saved.packages || {},
        room: roomOptions(saved.room),
        launchOptions:
          saved.launchOptions &&
          typeof saved.launchOptions === "object" &&
          !Array.isArray(saved.launchOptions)
            ? saved.launchOptions
            : {},
      };
    }
    this.config = config;
    this.revision = revision;
    return this;
  }
  async configRevision() {
    try {
      const stat = await fs.stat(this.configFile);
      return [stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino].join(":");
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      // Reading the file below must decide whether access is possible.
      return "unreadable:" + (error.code || "unknown");
    }
  }
  entry(id) {
    return catalogEntry(this.catalog, id);
  }
  async save() {
    await writeJson(this.configFile, this.config);
  }
  async launchOptionsFor(id, root = this.config.roots[id]) {
    const detected = await detectLanguages(this.entry(id), root);
    const saved = this.config.launchOptions[id]?.language;
    return {
      ...detected,
      language: detected.languages.some((l) => l.code === saved)
        ? saved
        : "english",
    };
  }
  async setLaunchOptions(input) {
    await this.load();
    const entry = this.entry(input?.id),
      root = this.config.roots[entry.id];
    await (entry.playable ? inspect(entry, root) : inspectArchive(entry, root));
    const language = languageCode(input?.language);
    const options = await this.launchOptionsFor(entry.id, root);
    if (!options.languages.some((l) => l.code === language))
      throw Error("此客户端未包含该界面语言资源");
    this.config.launchOptions[entry.id] = { language };
    await this.save();
    return { ...options, language };
  }
  async bindArchives(root) {
    await this.load();
    const checked = await readArchiveIndex(root);
    this.config.archiveRoot = checked.root;
    await this.save();
    return checked.root;
  }
  async bind(id, root) {
    await this.load();
    const e = this.entry(id);
    const check = await (e.playable
      ? inspect(e, root)
      : inspectArchive(e, root));
    this.config.roots[id] = check.root;
    await this.save();
    return check.root;
  }
  async package(id, file) {
    await this.load();
    const e = packageEvent(this.catalog, id);
    this.config.packages[id] = await inspectPackage(file, e.packageSha);
    await this.save();
  }
  async scan(base) {
    let examined = 0;
    const found = [];
    const byHash = new Map(
      this.catalog.entries.filter((e) => e.sha).map((e) => [e.sha, e]),
    );
    async function walk(dir, depth) {
      if (examined++ > 1000 || depth > 6) return;
      let children;
      try {
        children = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (children.some((e) => e.isFile() && e.name === "steam.inf")) {
        const e = byHash.get(await hash(path.join(dir, "steam.inf")));
        if (e) {
          const root = path.resolve(dir, e.source2 ? "../.." : "..");
          if (await exists(path.join(root, e.exe || e.archiveExe)))
            found.push({ id: e.id, root });
        }
      }
      for (const c of children)
        if (
          c.isDirectory() &&
          !/^(node_modules|\.git|private|staging|backups|logs|test-logs|maps|models|materials|sound|scripts|pak.*|gameinfo.gi)$/i.test(
            c.name,
          )
        )
          await walk(path.join(dir, c.name), depth + 1);
    }
    await walk(path.resolve(base), 0);
    const imported = [];
    for (const f of found)
      try {
        await this.bind(f.id, f.root);
        imported.push(f);
      } catch {}
    return imported;
  }
  async snapshot() {
    await this.load();
    const entries = await Promise.all(
      this.catalog.entries.map(async (e) => {
        const root = this.config.roots[e.id];
        let installed = false,
          archived = false,
          reason = root ? "目录或构建不匹配" : "未绑定文件夹";
        if (root && e.playable)
          try {
            await inspect(e, root);
            installed = true;
            reason = "客户端构建已核验";
          } catch (err) {
            reason = err.message;
          }
        if (root && !e.playable && e.archiveExe)
          try {
            await inspectArchive(e, root);
            archived = true;
            reason = e.menuOnly
              ? "主菜单可用，比赛组件缺失"
              : "档案已核验，比赛组件缺失";
          } catch (err) {
            reason = err.message;
          }
        const events = await Promise.all(
          e.events.map(async (v) => {
            let available = false,
              note = "请先绑定对应客户端";
            if (installed)
              try {
                await inspect(e, root, v.id, this.config.packages);
                available = true;
                note =
                  v.kind === "compat" ? "兼容入口已核验" : "地图入口已核验";
              } catch (err) {
                note = err.message;
              }
            return { ...v, available, note };
          }),
        );
        let launchOptions = {
          languages: [],
          language: "english",
          languageNote: "",
        };
        if (installed || archived)
          launchOptions = await this.launchOptionsFor(e.id, root);
        return {
          ...e,
          root: root || "",
          installed,
          archived,
          menuAvailable: installed || (archived && e.menuOnly === true),
          reason,
          events,
          ...launchOptions,
        };
      }),
    );
    return {
      entries,
      reviewDate: this.catalog.reviewDate,
      room: this.config.room,
      networks: networks(),
      dataDirectory: this.data,
      configRevision: this.revision,
      collection: await archiveSnapshot(this.config.archiveRoot, this.sources),
    };
  }
}
function networks() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, items]) =>
    (items || [])
      .filter((i) => i.family === "IPv4" && !i.internal)
      .map((i) => ({ name, address: i.address })),
  );
}
module.exports = { Library, networks };
