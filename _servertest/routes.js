"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureRoutes = configureRoutes;
const react_native_fs_1 = __importDefault(require("react-native-fs"));
function normalizeRel(rel) {
    const parts = rel.split(/[\/\\]/).filter((p) => p && p !== ".");
    const stack = [];
    for (const p of parts) {
        if (p === "..") {
            if (stack.length === 0)
                throw new Error("Path traversal");
            stack.pop();
        }
        else if (p.includes("\0")) {
            throw new Error("Invalid path");
        }
        else {
            stack.push(p);
        }
    }
    return stack.join("/");
}
function resolveSafe(baseDir, rel) {
    const norm = normalizeRel(rel);
    return norm ? `${baseDir}/${norm}` : baseDir;
}
function safeName(name) {
    const n = name.trim().replace(/^.*[\\\/]/, "");
    if (!n || n === "." || n === ".." || n.includes("\0"))
        return null;
    return n;
}
async function uniqueDest(dir, name) {
    let p = `${dir}/${name}`;
    if (!(await react_native_fs_1.default.exists(p)))
        return p;
    const dotIdx = name.lastIndexOf(".");
    const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
    const stem = dotIdx > 0 ? name.slice(0, dotIdx) : name;
    for (let i = 1; i < 10000; i++) {
        p = `${dir}/${stem} (${i})${ext}`;
        if (!(await react_native_fs_1.default.exists(p)))
            return p;
    }
    throw new Error("Could not find unique name");
}
function getMimeType(name) {
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    const map = {
        txt: "text/plain",
        md: "text/markdown",
        json: "application/json",
        html: "text/html",
        css: "text/css",
        js: "application/javascript",
        xml: "application/xml",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        bmp: "image/bmp",
        heic: "image/heic",
        mp4: "video/mp4",
        mov: "video/quicktime",
        webm: "video/webm",
        mkv: "video/x-matroska",
        avi: "video/x-msvideo",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        flac: "audio/flac",
        ogg: "audio/ogg",
        m4a: "audio/mp4",
        pdf: "application/pdf",
        zip: "application/zip",
        "7z": "application/x-7z-compressed",
        rar: "application/vnd.rar",
        apk: "application/vnd.android.package-archive",
    };
    return map[ext] || "application/octet-stream";
}
const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Dropt (phone)</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;background:#0f1115;color:#e6e8ed;padding:24px;line-height:1.5}
code{background:#1a1d24;padding:2px 6px;border-radius:4px;font-size:14px}
h1{font-size:22px;margin:0 0 12px}p{margin:8px 0}</style>
</head><body><h1>Dropt &middot; phone server</h1>
<p>Server is running. Connect from the desktop Dropt app or any HTTP client.</p>
<p>Endpoints:</p>
<ul>
<li><code>GET /info</code></li>
<li><code>GET /files?path=&lt;rel&gt;</code></li>
<li><code>GET /file?path=&lt;rel&gt;</code></li>
<li><code>POST /upload?path=&lt;rel&gt;</code> with header <code>X-Filename</code></li>
<li><code>DELETE /file?path=&lt;rel&gt;</code></li>
</ul>
</body></html>`;
function configureRoutes(server, opts) {
    const { baseDir, onTransfer } = opts;
    server.on("GET", "/", async (_req, res) => {
        res.send(200, { "Content-Type": "text/html; charset=utf-8" }, INDEX_HTML);
    });
    server.on("GET", "/info", async (_req, res) => {
        res.send(200, { "Content-Type": "application/json" }, JSON.stringify({ baseDir, version: "0.1.0", host: "phone" }));
    });
    server.on("GET", "/files", async (req, res) => {
        try {
            const rel = req.query.path || "";
            const dir = resolveSafe(baseDir, rel);
            const entries = await react_native_fs_1.default.readDir(dir);
            const list = entries.map((e) => ({
                name: e.name,
                size: parseInt(String(e.size), 10) || 0,
                isDirectory: e.isDirectory(),
                mtime: e.mtime ? e.mtime.toISOString() : null,
            }));
            list.sort((a, b) => {
                if (a.isDirectory !== b.isDirectory)
                    return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            res.send(200, { "Content-Type": "application/json" }, JSON.stringify(list));
        }
        catch (e) {
            res.send(404, {}, e instanceof Error ? e.message : String(e));
        }
    });
    server.on("GET", "/file", async (req, res) => {
        try {
            const rel = req.query.path || "";
            if (!rel) {
                res.send(400, {}, "path required");
                return;
            }
            const filePath = resolveSafe(baseDir, rel);
            const name = filePath.split("/").pop() || "file";
            const mime = getMimeType(name);
            await res.sendFile(200, filePath, mime, name);
            onTransfer?.({ kind: "download", name, ts: Date.now() });
        }
        catch (e) {
            res.send(500, {}, e instanceof Error ? e.message : String(e));
        }
    });
    server.on("POST", "/upload", async (req, res) => {
        try {
            const rel = req.query.path || "";
            const rawName = req.headers["x-filename"] || "";
            let decoded = rawName;
            try {
                decoded = decodeURIComponent(rawName);
            }
            catch { }
            const name = safeName(decoded);
            if (!name) {
                res.send(400, {}, "X-Filename header required");
                return;
            }
            const targetDir = resolveSafe(baseDir, rel);
            try {
                await react_native_fs_1.default.mkdir(targetDir);
            }
            catch { }
            const dest = await uniqueDest(targetDir, name);
            await req.streamToFile(dest);
            const finalName = dest.split("/").pop() || name;
            onTransfer?.({
                kind: "upload",
                name: finalName,
                size: req.contentLength,
                ts: Date.now(),
            });
            res.send(200, { "Content-Type": "application/json" }, JSON.stringify({ ok: true, savedAs: finalName }));
        }
        catch (e) {
            res.send(500, {}, e instanceof Error ? e.message : String(e));
        }
    });
    server.on("DELETE", "/file", async (req, res) => {
        try {
            const rel = req.query.path || "";
            if (!rel) {
                res.send(400, {}, "path required");
                return;
            }
            const filePath = resolveSafe(baseDir, rel);
            const name = filePath.split("/").pop() || "file";
            await react_native_fs_1.default.unlink(filePath);
            onTransfer?.({ kind: "delete", name, ts: Date.now() });
            res.send(200, {}, "OK");
        }
        catch (e) {
            res.send(404, {}, e instanceof Error ? e.message : String(e));
        }
    });
}
