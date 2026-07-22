import { createServer } from "node:https";
import { request } from "node:http";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * HTTPS reverse proxy in front of the plain-HTTP `next dev` server, so a phone
 * on the LAN gets a *trusted* secure context (needed for service worker / PWA
 * install). Uses the local CA cert in certs/ — install certs/rootCA.crt on the
 * phone once, then browse https://192.168.68.103:3443.
 *
 * Run alongside `npm run dev`:  npm run serve:https
 */
const cert = (f) => readFileSync(fileURLToPath(new URL(`../certs/${f}`, import.meta.url)));
const TARGET = { host: "127.0.0.1", port: Number(process.env.DEV_PORT ?? 3225) };
const PORT = Number(process.env.HTTPS_PORT ?? 3443);
const LAN = process.env.LAN_IP ?? "192.168.68.103";

const server = createServer(
  { key: cert("server.key"), cert: cert("server.crt") },
  (req, res) => {
    const proxyReq = request(
      { ...TARGET, method: req.method, path: req.url, headers: req.headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("proxy error");
    });
    req.pipe(proxyReq);
  },
);

// Forward the Next dev HMR websocket so the phone doesn't spam upgrade errors.
server.on("upgrade", (req, socket, head) => {
  const up = connect(TARGET.port, TARGET.host, () => {
    up.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (head?.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTPS proxy → http://${TARGET.host}:${TARGET.port}`);
  console.log(`  desktop:  https://localhost:${PORT}`);
  console.log(`  phone:    https://${LAN}:${PORT}   (install certs/rootCA.crt first)`);
});
