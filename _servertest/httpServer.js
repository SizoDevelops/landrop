"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpServer = exports.ServerResponse = exports.ServerRequest = void 0;
const react_native_tcp_socket_1 = __importDefault(require("react-native-tcp-socket"));
const react_native_fs_1 = __importDefault(require("react-native-fs"));
const buffer_1 = require("buffer");
function parseRequest(headBytes) {
    const headStr = headBytes.toString("latin1");
    const lines = headStr.split("\r\n");
    if (lines.length < 1)
        return null;
    const m = /^(\w+)\s+(\S+)\s+HTTP\/[\d.]+$/.exec(lines[0]);
    if (!m)
        return null;
    const method = m[1].toUpperCase();
    const fullPath = m[2];
    const qIdx = fullPath.indexOf("?");
    const path = qIdx >= 0 ? fullPath.slice(0, qIdx) : fullPath;
    const query = {};
    if (qIdx >= 0) {
        for (const pair of fullPath.slice(qIdx + 1).split("&")) {
            if (!pair)
                continue;
            const eq = pair.indexOf("=");
            const k = eq >= 0 ? pair.slice(0, eq) : pair;
            const v = eq >= 0 ? pair.slice(eq + 1) : "";
            try {
                query[decodeURIComponent(k)] = decodeURIComponent(v);
            }
            catch {
                query[k] = v;
            }
        }
    }
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const colon = line.indexOf(":");
        if (colon < 0)
            continue;
        headers[line.slice(0, colon).trim().toLowerCase()] = line
            .slice(colon + 1)
            .trim();
    }
    const bodyLength = parseInt(headers["content-length"] || "0", 10) || 0;
    return { method, path, query, headers, bodyLength };
}
function statusText(code) {
    const map = {
        200: "OK",
        201: "Created",
        204: "No Content",
        301: "Moved Permanently",
        304: "Not Modified",
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        405: "Method Not Allowed",
        500: "Internal Server Error",
    };
    return map[code] || "OK";
}
class ServerRequest {
    constructor(method, path, query, headers, contentLength, body) {
        this.method = method;
        this.path = path;
        this.query = query;
        this.headers = headers;
        this.contentLength = contentLength;
        this.body = body;
    }
    async readAll() {
        if (this.contentLength === 0)
            return buffer_1.Buffer.alloc(0);
        return new Promise((resolve, reject) => {
            const chunks = [];
            this.body.readBody((chunk) => chunks.push(chunk), () => resolve(buffer_1.Buffer.concat(chunks)), (e) => reject(e));
        });
    }
    async streamToFile(filePath, onProgress) {
        const total = this.contentLength;
        // Truncate/create the file once.
        await react_native_fs_1.default.writeFile(filePath, "", "utf8");
        if (total === 0)
            return;
        // RNFS.appendFile reopens+closes the file on every call, so appending per
        // network chunk (~16-64KB) is catastrophically slow. Instead we buffer
        // incoming data in memory and flush in large blocks, cutting the number of
        // file operations by ~100x.
        const FLUSH_BYTES = 4 * 1024 * 1024;
        let writtenToDisk = 0;
        let pending = [];
        let pendingBytes = 0;
        let flushChain = Promise.resolve();
        const flush = () => {
            if (pendingBytes === 0)
                return flushChain;
            const block = buffer_1.Buffer.concat(pending, pendingBytes);
            pending = [];
            pendingBytes = 0;
            flushChain = flushChain.then(async () => {
                await react_native_fs_1.default.appendFile(filePath, block.toString("base64"), "base64");
                writtenToDisk += block.length;
                onProgress?.(writtenToDisk, total);
            });
            return flushChain;
        };
        return new Promise((resolve, reject) => {
            this.body.readBody((chunk) => {
                pending.push(chunk);
                pendingBytes += chunk.length;
                if (pendingBytes >= FLUSH_BYTES)
                    flush();
            }, () => {
                flush().then(resolve, reject);
            }, (e) => reject(e));
        });
    }
}
exports.ServerRequest = ServerRequest;
class ServerResponse {
    constructor(socket) {
        this.socket = socket;
        this.sent = false;
    }
    // Resolves only once the native layer reports the bytes were written.
    writeAsync(buf) {
        return new Promise((resolve) => {
            try {
                this.socket.write(buf, undefined, () => resolve());
            }
            catch {
                resolve();
            }
        });
    }
    send(status, headers, body = "") {
        if (this.sent)
            return;
        this.sent = true;
        const bodyBuf = typeof body === "string" ? buffer_1.Buffer.from(body, "utf8") : body;
        const finalHeaders = {
            "Content-Length": String(bodyBuf.length),
            Connection: "close",
            "Cache-Control": "no-store",
            ...headers,
        };
        let head = `HTTP/1.1 ${status} ${statusText(status)}\r\n`;
        for (const [k, v] of Object.entries(finalHeaders))
            head += `${k}: ${v}\r\n`;
        head += "\r\n";
        // Send head+body as a single end(data) call: react-native-tcp-socket's
        // end() only waits for the write to flush when data is passed to it.
        // A bare write()+end() races and closes the socket before bytes go out.
        const full = bodyBuf.length > 0
            ? buffer_1.Buffer.concat([buffer_1.Buffer.from(head, "utf8"), bodyBuf])
            : buffer_1.Buffer.from(head, "utf8");
        try {
            this.socket.end(full);
        }
        catch { }
    }
    async sendFile(status, filePath, mimeType, fileName, onProgress) {
        if (this.sent)
            return;
        this.sent = true;
        let size = 0;
        try {
            const stat = await react_native_fs_1.default.stat(filePath);
            size = parseInt(String(stat.size), 10) || 0;
        }
        catch {
            this.sent = false;
            this.send(404, {}, "Not found");
            return;
        }
        const headers = {
            "Content-Length": String(size),
            "Content-Type": mimeType,
            "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
            Connection: "close",
        };
        let head = `HTTP/1.1 ${status} ${statusText(status)}\r\n`;
        for (const [k, v] of Object.entries(headers))
            head += `${k}: ${v}\r\n`;
        head += "\r\n";
        await this.writeAsync(buffer_1.Buffer.from(head, "utf8"));
        // Larger chunks mean far fewer RN-bridge round-trips (each crossing
        // base64-encodes), which is the dominant cost. 512KB balances throughput
        // against transient base64-string memory.
        const CHUNK = 512 * 1024;
        let offset = 0;
        while (offset < size) {
            const len = Math.min(CHUNK, size - offset);
            const b64 = await react_native_fs_1.default.read(filePath, len, offset, "base64");
            // Await each chunk's flush so we apply natural backpressure and so the
            // final chunk is fully written before we close the socket.
            await this.writeAsync(buffer_1.Buffer.from(b64, "base64"));
            offset += len;
            onProgress?.(offset, size);
        }
        try {
            this.socket.end();
        }
        catch { }
    }
}
exports.ServerResponse = ServerResponse;
class Connection {
    constructor(socket, dispatch) {
        this.socket = socket;
        this.dispatch = dispatch;
        this.buffer = buffer_1.Buffer.alloc(0);
        this.headersDone = false;
        // Body state — Connection is the single owner of socket 'data'.
        this.contentLength = 0;
        this.bodyReceived = 0;
        this.bodyDone = false;
        this.bodyQueue = [];
        this.pendingError = null;
        this.onChunk = null;
        this.onDone = null;
        this.onError = null;
        socket.on("data", (data) => this.onData(data));
        socket.on("error", (e) => {
            this.pendingError = e;
            if (this.onError)
                this.onError(e);
            try {
                socket.destroy();
            }
            catch { }
        });
    }
    // Route a slice of body bytes to the consumer (or buffer it), counting up to
    // Content-Length and signaling completion exactly once.
    feedBody(chunk) {
        if (this.bodyDone)
            return;
        const take = Math.min(chunk.length, this.contentLength - this.bodyReceived);
        if (take > 0) {
            const slice = take === chunk.length ? chunk : chunk.slice(0, take);
            this.bodyReceived += take;
            if (this.onChunk)
                this.onChunk(slice);
            else
                this.bodyQueue.push(slice);
        }
        if (this.bodyReceived >= this.contentLength) {
            this.bodyDone = true;
            if (this.onDone)
                this.onDone();
        }
    }
    // BodyReader: register a consumer. Drains anything already buffered, then
    // streams future chunks. Completion fires immediately if the body is done.
    readBody(onChunk, onDone, onError) {
        this.onChunk = onChunk;
        this.onDone = onDone;
        this.onError = onError;
        const queued = this.bodyQueue;
        this.bodyQueue = [];
        for (const c of queued)
            onChunk(c);
        if (this.pendingError)
            onError(this.pendingError);
        else if (this.bodyDone)
            onDone();
    }
    async onData(data) {
        if (this.headersDone) {
            this.feedBody(data);
            return;
        }
        this.buffer = buffer_1.Buffer.concat([this.buffer, data]);
        const sep = this.buffer.indexOf("\r\n\r\n");
        if (sep < 0)
            return;
        const head = this.buffer.slice(0, sep);
        const initialBody = this.buffer.slice(sep + 4);
        this.buffer = buffer_1.Buffer.alloc(0);
        this.headersDone = true;
        const parsed = parseRequest(head);
        if (!parsed) {
            new ServerResponse(this.socket).send(400, {}, "Bad Request");
            return;
        }
        this.contentLength = parsed.bodyLength;
        if (this.contentLength === 0)
            this.bodyDone = true;
        const req = new ServerRequest(parsed.method, parsed.path, parsed.query, parsed.headers, parsed.bodyLength, this);
        const res = new ServerResponse(this.socket);
        // Feed any body bytes that arrived in the same segment as the headers.
        if (initialBody.length > 0)
            this.feedBody(initialBody);
        try {
            await this.dispatch(req, res);
        }
        catch (e) {
            res.send(500, {}, e instanceof Error ? e.message : String(e));
        }
    }
}
class HttpServer {
    constructor() {
        this.tcp = null;
        this.routes = [];
    }
    on(method, pattern, handler) {
        const matcher = typeof pattern === "string"
            ? new RegExp("^" + pattern.replace(/\//g, "\\/") + "$")
            : pattern;
        this.routes.push({ method: method.toUpperCase(), matcher, handler });
    }
    start(port, host = "0.0.0.0") {
        return new Promise((resolve, reject) => {
            this.tcp = react_native_tcp_socket_1.default.createServer((socket) => {
                new Connection(socket, (req, res) => this.dispatch(req, res));
            });
            this.tcp.on("error", (err) => reject(err));
            this.tcp.listen({ port, host }, () => resolve());
        });
    }
    stop() {
        return new Promise((resolve) => {
            if (!this.tcp)
                return resolve();
            const tcp = this.tcp;
            this.tcp = null;
            try {
                tcp.close(() => resolve());
            }
            catch {
                resolve();
            }
        });
    }
    async dispatch(req, res) {
        for (const r of this.routes) {
            if (r.method === req.method && r.matcher.test(req.path)) {
                await r.handler(req, res);
                return;
            }
        }
        res.send(404, {}, "Not found");
    }
}
exports.HttpServer = HttpServer;
