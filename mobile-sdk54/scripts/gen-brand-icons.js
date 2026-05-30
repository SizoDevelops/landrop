// Generates app icon / splash / favicon PNGs from the Dropt brand spec
// (brand-assets.html). Run with: node scripts/gen-brand-icons.js
// Requires the rasterizer (build-only): npm install -D @resvg/resvg-js
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const GREEN = "#2faf5f";
const ASSETS = path.join(__dirname, "..", "assets");

// The download mark (file bars + arrow) in the spec's 180x180 icon canvas.
const MARK = `
  <rect x="55" y="48" width="70" height="6" rx="3" fill="${GREEN}" fill-opacity="0.30"/>
  <rect x="60" y="62" width="60" height="6" rx="3" fill="${GREEN}" fill-opacity="0.45"/>
  <rect x="78" y="64" width="24" height="48" rx="5" fill="${GREEN}"/>
  <path d="M40 96 L90 142 L140 96" stroke="${GREEN}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

const BG = `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0%" stop-color="#1a1a2e"/>
  <stop offset="40%" stop-color="#13131f"/>
  <stop offset="100%" stop-color="#0a0a10"/>
</linearGradient></defs>`;

// Full-bleed square (iOS masks corners itself; opaque background required).
const full = (s) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 180 180">${BG}<rect width="180" height="180" fill="url(#bg)"/>${MARK}</svg>`;

// Rounded badge on transparent - used for the splash logo.
const badge = (s) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 180 180">${BG}<rect x="10" y="10" width="160" height="160" rx="38" fill="url(#bg)" stroke="#2b2f35" stroke-width="0.5"/>${MARK}</svg>`;

// Android adaptive foreground: the full gradient tile baked in (NOT
// transparent) so the launcher mask reveals the brand background, with the
// mark kept inside the ~66% safe zone. The viewBox is padded out to 270 (the
// 108dp adaptive canvas vs the 72dp safe zone) so the 180-unit artwork lands
// centered within the safe area and nothing is clipped by the mask.
const adaptive = (s) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="-45 -45 270 270">${BG}<rect x="-45" y="-45" width="270" height="270" fill="url(#bg)"/>${MARK}</svg>`;

function render(svg, file) {
  const png = new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
  fs.writeFileSync(path.join(ASSETS, file), png);
  console.log("wrote", file, png.length, "bytes");
}

render(full(1024), "icon.png");
render(adaptive(1024), "adaptive-icon.png");
render(badge(1024), "splash-icon.png");
render(full(196), "favicon.png");

fs.mkdirSync(path.join(ASSETS, "brand"), { recursive: true });
fs.writeFileSync(path.join(ASSETS, "brand", "icon.svg"), badge(1024));
console.log("done");
