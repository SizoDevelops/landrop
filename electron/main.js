const { app, BrowserWindow, ipcMain, Notification, dialog, shell, Menu } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.LANDROP_PORT) || 8000;
const HOST = process.env.LANDROP_HOST || "0.0.0.0";
const VERSION = require("./package.json").version || "0.0.0";
let uploadDir =
  process.env.LANDROP_UPLOAD_DIR || path.join(app.getPath("downloads"), "LANDrop");
let mainWindow = null;
let httpServer = null;
let readOnly = false;

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"));
const DESKTOP_HTML = fs.readFileSync(path.join(__dirname, "public", "desktop.html"));

// ---- Live transfer / device tracking (powers the desktop dashboard) ----
// These are in-memory and reset when the app restarts; they exist purely so
// the Activity and Devices panels reflect real traffic instead of mock data.
let txnSeq = 0;
const transfers = new Map(); // id -> active transfer record
const history = []; // completed transfers, newest first (capped)
const devices = new Map(); // ip -> device record

function clientIp(req) {
  let ip = (req.socket && req.socket.remoteAddress) || "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // unwrap IPv4-mapped IPv6
  if (ip === "::1") ip = "127.0.0.1";
  return ip || "unknown";
}

function clientName(req) {
  const raw = req.headers["x-device-name"];
  if (!raw) return null;
  try {
    return decodeURIComponent(String(raw)).slice(0, 60);
  } catch {
    return String(raw).slice(0, 60);
  }
}

function touchDevice(ip, name) {
  const t = Date.now();
  let d = devices.get(ip);
  if (!d) {
    d = { ip, name: name || null, firstSeen: t, lastSeen: t, completed: 0 };
    devices.set(ip, d);
  }
  d.lastSeen = t;
  if (name) d.name = name;
  return d;
}

function pushHistory(rec) {
  history.unshift(rec);
  if (history.length > 50) history.length = 50;
}

function completeTransfer(t) {
  if (t.done) return;
  t.done = true;
  const dev = devices.get(t.ip);
  if (dev) dev.completed++;
  pushHistory({
    name: t.name,
    kind: t.kind,
    ip: t.ip,
    deviceName: t.deviceName || (dev && dev.name) || null,
    total: t.total,
    durationMs: Date.now() - t.startTime,
    at: Date.now(),
  });
  transfers.delete(t.id);
}

// A download "session" is keyed by client + file so the parallel range
// requests the phone fires for one file collapse into a single progress row.
function downloadSession(ip, name, total, dev) {
  const key = "dl|" + ip + "|" + name;
  const tn = Date.now();
  let t = transfers.get(key);
  if (!t) {
    t = {
      id: key,
      kind: "download",
      name,
      ip,
      deviceName: dev && dev.name,
      total,
      bytes: 0,
      startTime: tn,
      lastTime: tn,
      _sampleBytes: 0,
      _sampleTime: tn,
      speed: 0,
      streams: 0,
    };
    transfers.set(key, t);
  }
  if (total && total > t.total) t.total = total;
  if (dev && dev.name) t.deviceName = dev.name;
  return t;
}

function buildStatus() {
  const tn = Date.now();

  // Compute an instantaneous speed for each active transfer from the byte
  // delta since the previous sample (this fn is called once per ~1s poll).
  let downloading = 0;
  let uploading = 0;
  const activeTransfers = [];
  for (const t of transfers.values()) {
    const dt = (tn - t._sampleTime) / 1000;
    if (dt >= 0.2) {
      t.speed = Math.max(0, (t.bytes - t._sampleBytes) / dt);
      t._sampleBytes = t.bytes;
      t._sampleTime = tn;
    }
    if (t.kind === "upload") uploading++;
    else downloading++;
    activeTransfers.push({
      name: t.name,
      kind: t.kind,
      ip: t.ip,
      deviceName: t.deviceName || null,
      total: t.total,
      bytes: t.bytes,
      speed: Math.round(t.speed),
      pct: t.total ? Math.min(100, Math.round((t.bytes * 100) / t.total)) : 0,
      ageMs: tn - t.startTime,
    });
  }

  const deviceList = [];
  for (const d of devices.values()) {
    let dl = 0;
    let ul = 0;
    for (const t of transfers.values()) {
      if (t.ip !== d.ip) continue;
      if (t.kind === "upload") ul++;
      else dl++;
    }
    deviceList.push({
      ip: d.ip,
      name: d.name,
      online: tn - d.lastSeen < 30000,
      activeDownloads: dl,
      activeUploads: ul,
      completed: d.completed,
      lastSeen: d.lastSeen,
      connectedMs: tn - d.firstSeen,
    });
  }
  deviceList.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);

  return { downloading, uploading, activeTransfers, deviceList };
}

function safeName(raw) {
  if (!raw) return null;
  let name;
  try {
    name = decodeURIComponent(String(raw)).trim();
  } catch {
    return null;
  }
  name = path.basename(name);
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    return null;
  }
  return name;
}

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let i = 1; ; i++) {
    const cand = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
}

function sendText(res, code, body) {
  const buf = Buffer.from(body, "utf8");
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function notifyFilesChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("files-changed");
  }
}

function handleRequest(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const method = req.method;

  // CORS so the phone's WebView/fetch (and dev tools) can hit us freely.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Device-Name, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Discovery signature: the phone scans the LAN subnet hitting /ping and looks
  // for { app: "landrop" } to tell our server apart from any other HTTP service.
  if (method === "GET" && p === "/ping") {
    sendJson(res, 200, { app: "landrop", host: os.hostname(), port: PORT, readOnly });
    return;
  }

  // Desktop dashboard (loaded by the Electron window). Kept on a separate path
  // so phones hitting "/" still get the lightweight uploader.
  if (method === "GET" && (p === "/desktop" || p === "/desktop.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": DESKTOP_HTML.length,
      "Cache-Control": "no-store",
    });
    res.end(DESKTOP_HTML);
    return;
  }

  if (method === "GET" && (p === "/" || p === "/index.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": INDEX_HTML.length,
      "Cache-Control": "no-store",
    });
    res.end(INDEX_HTML);
    return;
  }

  // Full dashboard state — files + live transfers + devices. Polled by the
  // desktop window once per second.
  if (method === "GET" && p === "/status") {
    fs.readdir(uploadDir, { withFileTypes: true }, (err, entries) => {
      const files = [];
      let totalBytes = 0;
      if (!err) {
        for (const e of entries) {
          if (!e.isFile()) continue;
          let size = 0;
          let mtime = 0;
          try {
            const st = fs.statSync(path.join(uploadDir, e.name));
            size = st.size;
            mtime = st.mtimeMs;
          } catch {}
          totalBytes += size;
          files.push({ name: e.name, size, mtime });
        }
        files.sort((a, b) => b.mtime - a.mtime);
      }
      const live = buildStatus();
      sendJson(res, 200, {
        server: {
          ip: lanIp(),
          port: PORT,
          host: os.hostname(),
          url: `http://${lanIp()}:${PORT}/`,
          uploadDir,
          readOnly,
          version: VERSION,
        },
        stats: {
          downloading: live.downloading,
          uploading: live.uploading,
          totalBytes,
        },
        files,
        transfers: live.activeTransfers,
        history,
        devices: live.deviceList,
      });
    });
    return;
  }

  if (method === "GET" && p === "/files") {
    fs.readdir(uploadDir, { withFileTypes: true }, (err, entries) => {
      if (err) return sendText(res, 500, "Read dir failed");
      const files = entries
        .filter((e) => e.isFile())
        .map((e) => {
          let size = 0;
          let mtime = 0;
          try {
            const st = fs.statSync(path.join(uploadDir, e.name));
            size = st.size;
            mtime = st.mtimeMs;
          } catch {}
          return { name: e.name, size, mtime };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      sendJson(res, 200, files);
    });
    return;
  }

  if (method === "GET" && p.startsWith("/files/")) {
    const name = safeName(p.slice("/files/".length));
    if (!name) return sendText(res, 400, "Bad name");
    const target = path.join(uploadDir, name);
    fs.stat(target, (err, st) => {
      if (err || !st.isFile()) return sendText(res, 404, "Not found");
      try {
        res.socket && res.socket.setNoDelay(true);
      } catch {}

      // Track this download for the dashboard. Parallel range requests for the
      // same file share one session keyed by client + name.
      const ip = clientIp(req);
      const dev = touchDevice(ip, clientName(req));
      const txn = downloadSession(ip, name, st.size, dev);
      txn.streams++;
      txn.lastTime = Date.now();

      const base = {
        "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
      };
      const opts = { highWaterMark: 1024 * 1024 };

      const trackStream = (rs) => {
        rs.on("data", (chunk) => {
          txn.bytes += chunk.length;
          txn.lastTime = Date.now();
        });
        rs.on("error", () => res.destroy());
        const endOne = () => {
          txn.streams = Math.max(0, txn.streams - 1);
          if (txn.streams === 0 && txn.bytes >= txn.total - 4096) {
            completeTransfer(txn);
            notifyFilesChanged();
          }
        };
        res.on("close", endOne);
      };

      // Range support → enables the phone's parallel chunked downloads.
      const range = req.headers["range"];
      const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        let start = m[1] === "" ? undefined : parseInt(m[1], 10);
        let end = m[2] === "" ? undefined : parseInt(m[2], 10);
        if (start === undefined && end !== undefined) {
          // suffix: last N bytes
          start = Math.max(0, st.size - end);
          end = st.size - 1;
        } else {
          if (start === undefined) start = 0;
          if (end === undefined || end >= st.size) end = st.size - 1;
        }
        if (start > end || start >= st.size) {
          txn.streams = Math.max(0, txn.streams - 1);
          res.writeHead(416, { "Content-Range": `bytes */${st.size}`, "Accept-Ranges": "bytes" });
          res.end();
          return;
        }
        const len = end - start + 1;
        res.writeHead(206, {
          ...base,
          "Content-Range": `bytes ${start}-${end}/${st.size}`,
          "Content-Length": len,
        });
        const rs = fs.createReadStream(target, { start, end, ...opts });
        trackStream(rs);
        rs.pipe(res);
        return;
      }

      // Full file
      res.writeHead(200, { ...base, "Content-Length": st.size });
      const rs = fs.createReadStream(target, opts);
      trackStream(rs);
      rs.pipe(res);
    });
    return;
  }

  if (method === "POST" && p === "/upload") {
    if (readOnly) return sendText(res, 403, "Server is in read-only mode");
    const name = safeName(req.headers["x-filename"]);
    if (!name) return sendText(res, 400, "X-Filename header required");
    const dest = uniquePath(uploadDir, name);
    try {
      req.socket && req.socket.setNoDelay(true);
    } catch {}

    const ip = clientIp(req);
    const dev = touchDevice(ip, clientName(req));
    const total = Number(req.headers["content-length"]) || 0;
    const txnId = "ul|" + ip + "|" + name + "|" + ++txnSeq;
    const txn = {
      id: txnId,
      kind: "upload",
      name,
      ip,
      deviceName: dev && dev.name,
      total,
      bytes: 0,
      startTime: Date.now(),
      lastTime: Date.now(),
      _sampleBytes: 0,
      _sampleTime: Date.now(),
      speed: 0,
      streams: 1,
    };
    transfers.set(txnId, txn);

    // 1MB write buffer (vs Node's 16KB default) → larger disk writes and
    // coarser backpressure, higher throughput for phone→PC uploads.
    const ws = fs.createWriteStream(dest, { highWaterMark: 1024 * 1024 });
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      txn.bytes = bytes;
      txn.lastTime = Date.now();
    });
    req.on("aborted", () => {
      ws.destroy();
      transfers.delete(txnId);
      fsp.unlink(dest).catch(() => {});
    });
    ws.on("error", (err) => {
      transfers.delete(txnId);
      try {
        fs.unlinkSync(dest);
      } catch {}
      if (!res.headersSent) sendText(res, 500, "Write failed: " + err.message);
    });
    req.pipe(ws);
    ws.on("finish", () => {
      const savedAs = path.basename(dest);
      console.log(`  saved ${savedAs} (${bytes} bytes)`);
      txn.name = savedAs;
      completeTransfer(txn);
      notifyFilesChanged();
      try {
        new Notification({
          title: "LAN Drop",
          body: `Received ${savedAs}`,
        })
          .on("click", () => shell.openPath(uploadDir))
          .show();
      } catch {}
      sendJson(res, 200, { ok: true, savedAs });
    });
    return;
  }

  if (method === "DELETE" && p.startsWith("/files/")) {
    if (readOnly) return sendText(res, 403, "Server is in read-only mode");
    const name = safeName(p.slice("/files/".length));
    if (!name) return sendText(res, 400, "Bad name");
    const target = path.join(uploadDir, name);
    fs.unlink(target, (err) => {
      if (err) return sendText(res, err.code === "ENOENT" ? 404 : 500, "Delete failed");
      console.log(`  deleted ${name}`);
      notifyFilesChanged();
      sendText(res, 200, "OK");
    });
    return;
  }

  sendText(res, 404, "Not found");
}

// Periodic sweep: drop stalled/abandoned transfers and prune long-gone devices
// so the dashboard doesn't accumulate ghosts.
const sweepTimer = setInterval(() => {
  const tn = Date.now();
  for (const t of transfers.values()) {
    if (t.streams <= 0 && tn - t.lastTime > 15000) transfers.delete(t.id);
  }
  for (const d of devices.values()) {
    if (tn - d.lastSeen > 5 * 60 * 1000) devices.delete(d.ip);
  }
}, 5000);
if (sweepTimer.unref) sweepTimer.unref();

function lanIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [iface, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) {
        // Deprioritize virtual adapters (WSL, Hyper-V, hotspot) so the real
        // wifi/LAN address is preferred.
        const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback/i.test(iface);
        candidates.push({ addr: i.address, virtual });
      }
    }
  }
  const real = candidates.find((c) => !c.virtual);
  return (real || candidates[0])?.addr || "127.0.0.1";
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          { label: "Open uploads folder", click: () => shell.openPath(uploadDir) },
          { label: "Change uploads folder…", click: pickUploadFolder },
          { type: "separator" },
          isMac ? { role: "close" } : { role: "quit" },
        ],
      },
      { role: "viewMenu" },
    ])
  );
}

async function pickUploadFolder() {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "Choose uploads folder",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: uploadDir,
  });
  if (r.canceled || !r.filePaths[0]) return null;
  uploadDir = r.filePaths[0];
  await fsp.mkdir(uploadDir, { recursive: true });
  notifyFilesChanged();
  if (mainWindow) {
    mainWindow.setTitle(`LAN Drop — http://${lanIp()}:${PORT}/  ·  ${uploadDir}`);
  }
  return uploadDir;
}

async function createWindow() {
  await fsp.mkdir(uploadDir, { recursive: true });

  httpServer = http.createServer(handleRequest);
  httpServer.on("error", (err) => {
    dialog.showErrorBox("LAN Drop", `Server failed to start on port ${PORT}: ${err.message}`);
    app.quit();
  });
  await new Promise((resolve) => httpServer.listen(PORT, HOST, resolve));

  const ip = lanIp();
  console.log(`Phone URL: http://${ip}:${PORT}/`);
  console.log(`Saving to: ${uploadDir}`);

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#0b0e12",
    icon: path.join(__dirname, "public", "icon.png"),
    title: `LAN Drop — http://${ip}:${PORT}/  ·  ${uploadDir}`,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  buildMenu();
  await mainWindow.loadURL(`http://127.0.0.1:${PORT}/desktop`);
}

ipcMain.on("open-folder", () => shell.openPath(uploadDir));
ipcMain.on("quit-app", () => app.quit());
ipcMain.handle("pick-folder", () => pickUploadFolder());
ipcMain.handle("set-readonly", (_e, value) => {
  readOnly = !!value;
  return readOnly;
});
ipcMain.handle("get-info", () => ({
  ip: lanIp(),
  port: PORT,
  url: `http://${lanIp()}:${PORT}/`,
  uploadDir,
  readOnly,
  version: VERSION,
  host: os.hostname(),
}));

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (httpServer) httpServer.close();
  app.quit();
});
