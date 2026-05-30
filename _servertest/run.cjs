"use strict";
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { HttpServer } = require("./httpServer.js");
const { configureRoutes } = require("./routes.js");

const PORT = 8799;
const HOST = "127.0.0.1";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  ->  " + detail : ""}`); }
}

function req(method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: HOST, port: PORT, method, path: p, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    r.setTimeout(15000, () => { r.destroy(new Error("request timed out after 15s")); });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "landrop-test-"));
  await fsp.writeFile(path.join(baseDir, "hello.txt"), "hello world");
  await fsp.mkdir(path.join(baseDir, "sub"));
  await fsp.writeFile(path.join(baseDir, "sub", "nested.txt"), "deep");

  const transfers = [];
  const server = new HttpServer();
  configureRoutes(server, { baseDir, onTransfer: (e) => transfers.push(e) });
  await server.start(PORT, HOST);
  console.log(`\nServer up on http://${HOST}:${PORT}  baseDir=${baseDir}\n`);

  try {
    // 1. /info
    let r = await req("GET", "/info");
    let info = {};
    try { info = JSON.parse(r.body.toString()); } catch {}
    check("GET /info -> 200", r.status === 200, `status=${r.status}`);
    check("GET /info body has baseDir", info.baseDir === baseDir, info.baseDir);
    check("GET /info NON-EMPTY (the bug)", r.body.length > 0, `${r.body.length} bytes`);

    // 2. root listing
    r = await req("GET", "/files?path=");
    const list = JSON.parse(r.body.toString());
    const names = list.map((e) => e.name).sort();
    check("GET /files -> 200", r.status === 200, `status=${r.status}`);
    check("GET /files has hello.txt + sub", names.includes("hello.txt") && names.includes("sub"), names.join(","));
    check("GET /files marks dir", list.find((e) => e.name === "sub")?.isDirectory === true);

    // 3. nested listing
    r = await req("GET", "/files?path=sub");
    const sub = JSON.parse(r.body.toString());
    check("GET /files?path=sub lists nested.txt", sub.some((e) => e.name === "nested.txt"));

    // 4. download existing
    r = await req("GET", "/file?path=hello.txt");
    check("GET /file hello.txt -> 200", r.status === 200, `status=${r.status}`);
    check("GET /file hello.txt content", r.body.toString() === "hello world", JSON.stringify(r.body.toString()));
    check("GET /file sets Content-Disposition", /attachment/.test(r.headers["content-disposition"] || ""));

    // 5. upload
    const payload = Buffer.from("uploaded-bytes-12345");
    r = await req("POST", "/upload?path=", {
      headers: { "X-Filename": "up.bin", "Content-Length": payload.length },
      body: payload,
    });
    let up = {};
    try { up = JSON.parse(r.body.toString()); } catch {}
    check("POST /upload -> 200", r.status === 200, `status=${r.status}`);
    check("POST /upload savedAs up.bin", up.savedAs === "up.bin", up.savedAs);
    const onDisk = await fsp.readFile(path.join(baseDir, "up.bin"));
    check("uploaded bytes match on disk", onDisk.equals(payload), onDisk.toString());

    // 6. round-trip download of the uploaded file
    r = await req("GET", "/file?path=up.bin");
    check("download uploaded file matches", Buffer.compare(r.body, payload) === 0);

    // 7. dedupe on duplicate name
    r = await req("POST", "/upload?path=", {
      headers: { "X-Filename": "up.bin", "Content-Length": payload.length },
      body: payload,
    });
    up = JSON.parse(r.body.toString());
    check("duplicate upload deduped to 'up (1).bin'", up.savedAs === "up (1).bin", up.savedAs);

    // 8. path traversal on filename header -> stripped
    r = await req("POST", "/upload?path=", {
      headers: { "X-Filename": encodeURIComponent("../escape.bin"), "Content-Length": payload.length },
      body: payload,
    });
    up = JSON.parse(r.body.toString());
    const escaped = fs.existsSync(path.join(path.dirname(baseDir), "escape.bin"));
    check("traversal filename stripped to basename", up.savedAs === "escape.bin", up.savedAs);
    check("no file escaped baseDir", !escaped);

    // 9. path traversal on query path -> blocked
    r = await req("GET", "/files?path=" + encodeURIComponent("../.."));
    check("traversal in ?path rejected", r.status === 404 || r.status === 500, `status=${r.status}`);

    // 10. delete
    r = await req("DELETE", "/file?path=up.bin");
    check("DELETE /file -> 200", r.status === 200, `status=${r.status}`);
    check("file removed from disk", !fs.existsSync(path.join(baseDir, "up.bin")));

    // 11. delete missing -> 404
    r = await req("DELETE", "/file?path=does-not-exist.bin");
    check("DELETE missing -> 404", r.status === 404, `status=${r.status}`);

    // 12. unknown route
    r = await req("GET", "/nope");
    check("unknown route -> 404", r.status === 404, `status=${r.status}`);

    // 13. transfer events fired
    check("onTransfer fired for upload+download+delete", transfers.length >= 3, `count=${transfers.length}`);

    // 14. large file round-trip crossing the 4MB batch-flush boundary
    const big = Buffer.alloc(10 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const t0 = Date.now();
    r = await req("POST", "/upload?path=", {
      headers: { "X-Filename": "big.bin", "Content-Length": big.length },
      body: big,
    });
    const upBig = JSON.parse(r.body.toString());
    check("big upload -> 200", r.status === 200, `status=${r.status}`);
    const bigOnDisk = await fsp.readFile(path.join(baseDir, upBig.savedAs));
    check("big upload integrity (10MB, multi-block)", bigOnDisk.equals(big), `len=${bigOnDisk.length}`);
    r = await req("GET", "/file?path=" + encodeURIComponent(upBig.savedAs));
    check("big download integrity (10MB)", Buffer.compare(r.body, big) === 0, `len=${r.body.length}`);
    console.log(`  (10MB round-trip took ${Date.now() - t0}ms in the Node harness)`);

  } catch (e) {
    fail++;
    console.log(`  FAIL  harness threw -> ${e && e.stack ? e.stack : e}`);
  } finally {
    await server.stop().catch(() => {});
    await fsp.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
})();
