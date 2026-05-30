// Renders the Dropt brand mark (the same glyph used in the app topbar) into
// a 1024x1024 PNG using an offscreen Electron window, then writes it to
// build/icon.png and public/icon.png. A separate step packs it into an .ico.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SIZE = 1024;

// Brand glyph authored in a 22-unit viewBox (matches the topbar/nav-bar logo,
// including the two keyhole dots), drawn large on a dark rounded tile with the
// green accent strokes — the same look as the in-app nav-bar logo.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;background:transparent}
  svg{display:block}
</style></head><body>
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a1f25"/>
      <stop offset="1" stop-color="#0d1014"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1024" height="1024" rx="224" ry="224" fill="url(#bg)"/>
  <rect x="20" y="20" width="984" height="984" rx="204" fill="none" stroke="#2b3038" stroke-width="8"/>
  <g transform="translate(232,232) scale(25.45)"
     stroke="#2faf5f" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="8" width="18" height="12" rx="2" fill="none"/>
    <rect x="4.4" y="14.1" width="1.9" height="1.9" rx=".6" fill="#2faf5f" stroke="none" opacity=".5"/>
    <rect x="6.9" y="14.1" width="1.9" height="1.9" rx=".6" fill="#2faf5f" stroke="none" opacity=".5"/>
    <path d="M7 8V6a4 4 0 0 1 8 0v2" fill="none"/>
    <path d="M11.2 11v5m0 0 1.9-1.9m-1.9 1.9-1.9-1.9" fill="none"/>
  </g>
</svg>
</body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: false },
  });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  // Give the renderer a beat to paint the SVG before capturing.
  await new Promise((r) => setTimeout(r, 400));
  let image = await win.webContents.capturePage();
  const sz = image.getSize();
  if (sz.width !== SIZE || sz.height !== SIZE) {
    image = image.resize({ width: SIZE, height: SIZE, quality: "best" });
  }
  const png = image.toPNG();

  const buildDir = path.join(__dirname, "..", "build");
  const publicDir = path.join(__dirname, "..", "public");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "icon.png"), png);
  fs.writeFileSync(path.join(publicDir, "icon.png"), png);
  console.log("wrote build/icon.png and public/icon.png (" + png.length + " bytes)");
  app.quit();
});
