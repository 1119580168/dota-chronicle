const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { Readable } = require("node:stream");
const path = require("node:path");
const crypto = require("node:crypto");
const f = require("./files.cjs");
const TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webm": "video/webm",
};
const KINDS = ["cover", "menu", "selection", "gameplay", "video"];
function rangeFor(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) throw Error("Invalid range");
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size
  )
    throw Error("Invalid range");
  return { start, end, partial: true };
}
class MediaLibrary {
  constructor(data, catalog) {
    this.data = data;
    this.targets = new Set(
      catalog.entries.flatMap((e) => [e.id, ...e.events.map((v) => v.id)]),
    );
    this.index = { schema: 1, assets: {}, targets: {} };
  }
  async load() {
    const config = await f
      .readJson(path.join(this.data, "media.json"))
      .catch(() => ({}));
    this.root = config.root || path.join(this.data, "media");
    if (!path.isAbsolute(this.root)) throw Error("媒体库必须使用实际绝对路径");
    await f.noLinks(this.root);
    const index = await f
      .readJson(path.join(this.root, "index.json"))
      .catch(() => null);
    if (index?.schema === 1 && index.assets && index.targets)
      this.index = index;
    return this;
  }
  async resolve(id) {
    if (!/^[a-f0-9]{64}$/.test(id || "")) throw Error("未知媒体");
    const a = this.index.assets[id];
    if (!a || typeof a.file !== "string" || !TYPES[path.extname(a.file)])
      throw Error("未知媒体");
    const file = f.inside(this.root, a.file);
    await f.noLinks(file);
    const stat = await fs.stat(file);
    if (!stat.isFile() || !stat.size) throw Error("媒体文件不可用");
    return { file, stat, asset: a };
  }
  async describe(id) {
    try {
      const { asset, file } = await this.resolve(id);
      return {
        id,
        url: `chronicle://app/media/${id}${path.extname(file)}`,
        title: String(asset.title || ""),
        source: String(asset.source || ""),
        kind: asset.kind,
        build: String(asset.build || ""),
        type: TYPES[path.extname(file)],
      };
    } catch {
      return null;
    }
  }
  async forTarget(target) {
    const row = this.index.targets[target] || {},
      shots = {};
    for (const kind of ["menu", "selection", "gameplay"])
      shots[kind] = await this.describe(row[kind]);
    const videos = (
      await Promise.all(
        (row.videos || []).slice(0, 20).map((id) => this.describe(id)),
      )
    ).filter(Boolean);
    return {
      cover: (await this.describe(row.cover)) || shots.menu || shots.gameplay,
      shots,
      videos,
    };
  }
  async hydrate(snapshot) {
    for (const e of snapshot.entries) {
      e.media = e.installed || e.archived ? await this.forTarget(e.id) : null;
      for (const event of e.events)
        event.media = e.installed ? await this.forTarget(event.id) : null;
    }
    return snapshot;
  }
  validateTarget(target, kind) {
    if (!this.targets.has(target) || !KINDS.includes(kind))
      throw Error("未知档案或素材类型");
  }
  async importFile(target, kind, source, title = "") {
    this.validateTarget(target, kind);
    const ext = path.extname(source).toLowerCase().replace(".jpeg", ".jpg");
    if (!TYPES[ext] || (kind === "video") !== (ext === ".webm"))
      throw Error("图片支持 PNG/JPEG，视频支持 WebM");
    await f.noLinks(source);
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size > (kind === "video" ? 300 : 20) * 1024 ** 2)
      throw Error("素材过大或不是文件");
    const raw = await fs.readFile(source);
    const valid =
      ext === ".png"
        ? raw.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        : ext === ".jpg"
          ? raw[0] === 255 && raw[1] === 216
          : raw.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"));
    if (!valid) throw Error("素材内容与文件类型不符");
    const id = crypto.createHash("sha256").update(raw).digest("hex"),
      rel = `assets/${id}${ext}`;
    const dest = f.inside(this.root, rel);
    await f.noLinks(dest);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, raw, { flag: "wx" }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    this.index.assets[id] ||= {
      file: rel,
      kind,
      title: title || `${target} · ${kind}`,
      source: "手动导入的本地素材",
      importedUtc: new Date().toISOString(),
    };
    const row = (this.index.targets[target] ||= {});
    if (kind === "video")
      row.videos = [...new Set([...(row.videos || []), id])];
    else row[kind] = id;
    await f.writeJson(path.join(this.root, "index.json"), this.index);
    return this.forTarget(target);
  }
  async response(request) {
    const m = /^\/media\/([a-f0-9]{64})(\.(?:png|jpg|webm))$/.exec(
      new URL(request.url).pathname,
    );
    if (!m || !["GET", "HEAD"].includes(request.method))
      return new Response("Not found", { status: 404 });
    try {
      const { file, stat } = await this.resolve(m[1]);
      if (path.extname(file) !== m[2]) throw Error("Wrong extension");
      let range;
      try {
        range = rangeFor(request.headers.get("range"), stat.size);
      } catch {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${stat.size}` },
        });
      }
      const headers = {
        "Content-Type": TYPES[m[2]],
        "Content-Length": String(range.end - range.start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      };
      if (range.partial)
        headers["Content-Range"] =
          `bytes ${range.start}-${range.end}/${stat.size}`;
      return new Response(
        request.method === "HEAD"
          ? null
          : Readable.toWeb(
              createReadStream(file, { start: range.start, end: range.end }),
            ),
        { status: range.partial ? 206 : 200, headers },
      );
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }
}
module.exports = { MediaLibrary, rangeFor };
