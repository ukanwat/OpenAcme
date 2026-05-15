import http from "node:http";
import type { RequestListener } from "node:http";
import type { Duplex } from "node:stream";

export interface DevHttpServerOptions {
  honoListener: RequestListener;
  proxyTarget: URL;
}

type Target = { host: string; port: number };

export function createDevHttpServer(opts: DevHttpServerOptions): http.Server {
  const { honoListener, proxyTarget } = opts;
  const target: Target = {
    host: proxyTarget.hostname,
    port: Number(proxyTarget.port) || (proxyTarget.protocol === "https:" ? 443 : 80),
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/api" || url.startsWith("/api/")) {
      honoListener(req, res);
      return;
    }
    proxyHttp(req, res, target);
  });

  server.on("upgrade", (req, socket, head) => {
    proxyUpgrade(req, socket, head, target);
  });

  return server;
}

function proxyHttp(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  target: Target,
): void {
  const proxyReq = http.request(
    {
      host: target.host,
      port: target.port,
      method: clientReq.method,
      path: clientReq.url,
      headers: { ...clientReq.headers, host: `${target.host}:${target.port}` },
    },
    (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(clientRes);
    },
  );
  proxyReq.on("error", (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "text/plain" });
    }
    clientRes.end(`dev proxy error: ${err.message}`);
  });
  clientReq.pipe(proxyReq);
}

function proxyUpgrade(
  clientReq: http.IncomingMessage,
  clientSocket: Duplex,
  clientHead: Buffer,
  target: Target,
): void {
  const proxyReq = http.request({
    host: target.host,
    port: target.port,
    method: clientReq.method,
    path: clientReq.url,
    headers: { ...clientReq.headers, host: `${target.host}:${target.port}` },
  });
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ""}`];
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
      else if (v != null) lines.push(`${k}: ${v}`);
    }
    lines.push("", "");
    clientSocket.write(lines.join("\r\n"));
    if (proxyHead.length) clientSocket.write(proxyHead);
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
    proxySocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => proxySocket.destroy());
  });
  proxyReq.on("error", () => clientSocket.destroy());
  if (clientHead.length) proxyReq.write(clientHead);
  proxyReq.end();
}
