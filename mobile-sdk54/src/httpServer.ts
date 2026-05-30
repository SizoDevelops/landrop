import TcpSocket from "react-native-tcp-socket";
import RNFS from "react-native-fs";
import { Buffer } from "buffer";

type Headers = Record<string, string>;

type ParsedRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  bodyLength: number;
};

export type RouteHandler = (
  req: ServerRequest,
  res: ServerResponse
) => Promise<void> | void;

function parseRequest(headBytes: Buffer): ParsedRequest | null {
  const headStr = headBytes.toString("latin1");
  const lines = headStr.split("\r\n");
  if (lines.length < 1) return null;
  const m = /^(\w+)\s+(\S+)\s+HTTP\/[\d.]+$/.exec(lines[0]);
  if (!m) return null;
  const method = m[1].toUpperCase();
  const fullPath = m[2];
  const qIdx = fullPath.indexOf("?");
  const path = qIdx >= 0 ? fullPath.slice(0, qIdx) : fullPath;
  const query: Record<string, string> = {};
  if (qIdx >= 0) {
    for (const pair of fullPath.slice(qIdx + 1).split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      const v = eq >= 0 ? pair.slice(eq + 1) : "";
      try {
        query[decodeURIComponent(k)] = decodeURIComponent(v);
      } catch {
        query[k] = v;
      }
    }
  }
  const headers: Headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line
      .slice(colon + 1)
      .trim();
  }
  const bodyLength = parseInt(headers["content-length"] || "0", 10) || 0;
  return { method, path, query, headers, bodyLength };
}

function statusText(code: number): string {
  const map: Record<number, string> = {
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

// A source of request-body bytes. Connection implements this; it owns the
// single socket 'data' listener, counts bytes up to Content-Length, buffers
// anything that arrives before a consumer registers, and signals completion.
export interface BodyReader {
  readBody(
    onChunk: (chunk: Buffer) => void,
    onDone: () => void,
    onError: (e: Error) => void
  ): void;
}

export class ServerRequest {
  constructor(
    public method: string,
    public path: string,
    public query: Record<string, string>,
    public headers: Headers,
    public contentLength: number,
    private body: BodyReader
  ) {}

  async readAll(): Promise<Buffer> {
    if (this.contentLength === 0) return Buffer.alloc(0);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      this.body.readBody(
        (chunk) => chunks.push(chunk),
        () => resolve(Buffer.concat(chunks)),
        (e) => reject(e)
      );
    });
  }

  async streamToFile(
    filePath: string,
    onProgress?: (bytesWritten: number, total: number) => void
  ): Promise<void> {
    const total = this.contentLength;
    // Truncate/create the file once.
    await RNFS.writeFile(filePath, "", "utf8");
    if (total === 0) return;

    // RNFS.appendFile reopens+closes the file on every call, so appending per
    // network chunk (~16-64KB) is catastrophically slow. Instead we buffer
    // incoming data in memory and flush in large blocks, cutting the number of
    // file operations by ~100x.
    const FLUSH_BYTES = 4 * 1024 * 1024;
    let writtenToDisk = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let flushChain: Promise<void> = Promise.resolve();

    const flush = (): Promise<void> => {
      if (pendingBytes === 0) return flushChain;
      const block = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      flushChain = flushChain.then(async () => {
        await RNFS.appendFile(filePath, block.toString("base64"), "base64");
        writtenToDisk += block.length;
        onProgress?.(writtenToDisk, total);
      });
      return flushChain;
    };

    return new Promise((resolve, reject) => {
      this.body.readBody(
        (chunk) => {
          pending.push(chunk);
          pendingBytes += chunk.length;
          if (pendingBytes >= FLUSH_BYTES) flush();
        },
        () => {
          flush().then(resolve, reject);
        },
        (e) => reject(e)
      );
    });
  }
}

export class ServerResponse {
  private sent = false;
  constructor(private socket: any) {}

  // Resolves only once the native layer reports the bytes were written.
  private writeAsync(buf: Buffer): Promise<void> {
    return new Promise((resolve) => {
      try {
        this.socket.write(buf, undefined, () => resolve());
      } catch {
        resolve();
      }
    });
  }

  send(status: number, headers: Headers, body: string | Buffer = "") {
    if (this.sent) return;
    this.sent = true;
    const bodyBuf =
      typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const finalHeaders: Headers = {
      "Content-Length": String(bodyBuf.length),
      Connection: "close",
      "Cache-Control": "no-store",
      ...headers,
    };
    let head = `HTTP/1.1 ${status} ${statusText(status)}\r\n`;
    for (const [k, v] of Object.entries(finalHeaders)) head += `${k}: ${v}\r\n`;
    head += "\r\n";
    // Send head+body as a single end(data) call: react-native-tcp-socket's
    // end() only waits for the write to flush when data is passed to it.
    // A bare write()+end() races and closes the socket before bytes go out.
    const full =
      bodyBuf.length > 0
        ? Buffer.concat([Buffer.from(head, "utf8"), bodyBuf])
        : Buffer.from(head, "utf8");
    try {
      this.socket.end(full);
    } catch {}
  }

  async sendFile(
    status: number,
    filePath: string,
    mimeType: string,
    fileName: string,
    onProgress?: (sent: number, total: number) => void
  ): Promise<void> {
    if (this.sent) return;
    this.sent = true;
    let size = 0;
    try {
      const stat = await RNFS.stat(filePath);
      size = parseInt(String(stat.size), 10) || 0;
    } catch {
      this.sent = false;
      this.send(404, {}, "Not found");
      return;
    }
    const headers: Headers = {
      "Content-Length": String(size),
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${fileName.replace(
        /"/g,
        ""
      )}"`,
      Connection: "close",
    };
    let head = `HTTP/1.1 ${status} ${statusText(status)}\r\n`;
    for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
    head += "\r\n";
    await this.writeAsync(Buffer.from(head, "utf8"));

    // Larger chunks mean far fewer RN-bridge round-trips (each crossing
    // base64-encodes), which is the dominant cost. 512KB balances throughput
    // against transient base64-string memory.
    const CHUNK = 512 * 1024;
    let offset = 0;
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset);
      const b64 = await RNFS.read(filePath, len, offset, "base64");
      // Await each chunk's flush so we apply natural backpressure and so the
      // final chunk is fully written before we close the socket.
      await this.writeAsync(Buffer.from(b64, "base64"));
      offset += len;
      onProgress?.(offset, size);
    }
    try {
      this.socket.end();
    } catch {}
  }
}

class Connection implements BodyReader {
  private buffer: Buffer = Buffer.alloc(0);
  private headersDone = false;

  // Body state — Connection is the single owner of socket 'data'.
  private contentLength = 0;
  private bodyReceived = 0;
  private bodyDone = false;
  private bodyQueue: Buffer[] = [];
  private pendingError: Error | null = null;
  private onChunk: ((chunk: Buffer) => void) | null = null;
  private onDone: (() => void) | null = null;
  private onError: ((e: Error) => void) | null = null;

  constructor(
    private socket: any,
    private dispatch: (req: ServerRequest, res: ServerResponse) => Promise<void>
  ) {
    socket.on("data", (data: Buffer) => this.onData(data));
    socket.on("error", (e: Error) => {
      this.pendingError = e;
      if (this.onError) this.onError(e);
      try {
        socket.destroy();
      } catch {}
    });
  }

  // Route a slice of body bytes to the consumer (or buffer it), counting up to
  // Content-Length and signaling completion exactly once.
  private feedBody(chunk: Buffer) {
    if (this.bodyDone) return;
    const take = Math.min(chunk.length, this.contentLength - this.bodyReceived);
    if (take > 0) {
      const slice = take === chunk.length ? chunk : chunk.slice(0, take);
      this.bodyReceived += take;
      if (this.onChunk) this.onChunk(slice);
      else this.bodyQueue.push(slice);
    }
    if (this.bodyReceived >= this.contentLength) {
      this.bodyDone = true;
      if (this.onDone) this.onDone();
    }
  }

  // BodyReader: register a consumer. Drains anything already buffered, then
  // streams future chunks. Completion fires immediately if the body is done.
  readBody(
    onChunk: (chunk: Buffer) => void,
    onDone: () => void,
    onError: (e: Error) => void
  ) {
    this.onChunk = onChunk;
    this.onDone = onDone;
    this.onError = onError;
    const queued = this.bodyQueue;
    this.bodyQueue = [];
    for (const c of queued) onChunk(c);
    if (this.pendingError) onError(this.pendingError);
    else if (this.bodyDone) onDone();
  }

  private async onData(data: Buffer) {
    if (this.headersDone) {
      this.feedBody(data);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, data]);
    const sep = this.buffer.indexOf("\r\n\r\n");
    if (sep < 0) return;

    const head = this.buffer.slice(0, sep);
    const initialBody = this.buffer.slice(sep + 4);
    this.buffer = Buffer.alloc(0);
    this.headersDone = true;

    const parsed = parseRequest(head);
    if (!parsed) {
      new ServerResponse(this.socket).send(400, {}, "Bad Request");
      return;
    }
    this.contentLength = parsed.bodyLength;
    if (this.contentLength === 0) this.bodyDone = true;

    const req = new ServerRequest(
      parsed.method,
      parsed.path,
      parsed.query,
      parsed.headers,
      parsed.bodyLength,
      this
    );
    const res = new ServerResponse(this.socket);

    // Feed any body bytes that arrived in the same segment as the headers.
    if (initialBody.length > 0) this.feedBody(initialBody);

    try {
      await this.dispatch(req, res);
    } catch (e) {
      res.send(500, {}, e instanceof Error ? e.message : String(e));
    }
  }
}

type Route = { method: string; matcher: RegExp; handler: RouteHandler };

export class HttpServer {
  private tcp: any = null;
  private routes: Route[] = [];

  on(method: string, pattern: string | RegExp, handler: RouteHandler) {
    const matcher =
      typeof pattern === "string"
        ? new RegExp("^" + pattern.replace(/\//g, "\\/") + "$")
        : pattern;
    this.routes.push({ method: method.toUpperCase(), matcher, handler });
  }

  start(port: number, host: string = "0.0.0.0"): Promise<void> {
    return new Promise((resolve, reject) => {
      this.tcp = TcpSocket.createServer((socket: any) => {
        new Connection(socket, (req, res) => this.dispatch(req, res));
      });
      this.tcp.on("error", (err: Error) => reject(err));
      this.tcp.listen({ port, host }, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.tcp) return resolve();
      const tcp = this.tcp;
      this.tcp = null;
      try {
        tcp.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private async dispatch(req: ServerRequest, res: ServerResponse) {
    for (const r of this.routes) {
      if (r.method === req.method && r.matcher.test(req.path)) {
        await r.handler(req, res);
        return;
      }
    }
    res.send(404, {}, "Not found");
  }
}
