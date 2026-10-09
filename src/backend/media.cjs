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
const assetId = (id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const emptyIndex = () => ({ schema: 1, assets: {}, targets: {} });
function validateIndex(index, root) {
  if (
    !record(index) ||
    index.schema !== 1 ||
    !record(index.assets) ||
    !record(index.targets)
  )
    throw Error("媒体索引 schema 1 结构无效");
  for (const [id, asset] of Object.entries(index.assets)) {
    if (
      !assetId(id) ||
      !record(asset) ||
      typeof asset.file !== "string" ||
      !TYPES[path.extname(asset.file)] ||
      !KINDS.includes(asset.kind)
    )
      throw Error("媒体索引素材记录无效");
    f.inside(root, asset.file);
  }
  for (const row of Object.values(index.targets)) {
    if (
      !record(row) ||
      ["cover", "menu", "selection", "gameplay"].some(
        (kind) => row[kind] != null && !assetId(row[kind]),
      ) ||
      (row.videos != null &&
        (!Array.isArray(row.videos) || !row.videos.every(assetId)))
    )
      throw Error("媒体索引档案绑定无效");
  }
}
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
    this.index = emptyIndex();
    this.status = {
      available: false,
      canImport: false,
      error: "媒体库尚未读取",
    };
  }
  async load() {
    let file = path.join(this.data, "media.json"),
      label = "媒体配置";
    const readOptional = async (p) => {
      try {
        return await f.readJson(p);
      } catch (e) {
        if (e.code === "ENOENT") return undefined;
        throw e;
      }
    };
    try {
      await f.noLinks(file);
      const config = await readOptional(file);
      if (
        config !== undefined &&
        (!record(config) ||
          typeof config.root !== "string" ||
          !config.root.trim())
      )
        throw Error("媒体配置必须指定实际绝对目录 root");
      const root =
        config === undefined ? path.join(this.data, "media") : config.root;
      if (!path.isAbsolute(root)) throw Error("媒体库必须使用实际绝对路径");
      await f.noLinks(root);
      file = path.join(root, "index.json");
      label = "媒体索引";
      await f.noLinks(file);
      const saved = await readOptional(file),
        index = saved === undefined ? emptyIndex() : saved;
      validateIndex(index, root);
      this.root = root;
      this.index = index;
      this.status = { available: true, canImport: true, error: null, file };
    } catch (e) {
      this.status = {
        available: false,
        canImport: false,
        file,
        error: `${label}不可用：${e.message}。请修复该文件或访问权限后重新核对档案；导入已停用，原文件未改写。`,
      };
    }
    return this;
  }
  assertWritable() {
    if (!this.status.canImport) throw Error(this.status.error);
  }
  async resolve(id) {
    this.assertWritable();
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
    if (!this.status.available)
      return { cover: null, shots: {}, videos: [], status: { ...this.status } };
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
      status: { ...this.status },
    };
  }
  async hydrate(snapshot) {
    snapshot.mediaStatus = { ...this.status };
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
    // Re-read immediately before importing, including changes since the last snapshot.
    await this.load();
    this.assertWritable();
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
    const nextIndex = structuredClone(this.index);
    nextIndex.assets[id] ||= {
      file: rel,
      kind,
      title: title || `${target} · ${kind}`,
      source: "手动导入的本地素材",
      importedUtc: new Date().toISOString(),
    };
    const row = (nextIndex.targets[target] ||= {});
    if (kind === "video")
      row.videos = [...new Set([...(row.videos || []), id])];
    else row[kind] = id;
    await f.writeJson(path.join(this.root, "index.json"), nextIndex);
    this.index = nextIndex;
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
