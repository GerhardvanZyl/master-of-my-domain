// ponytail: throwaway harvest receiver — browser can't write files, this can.
import http from "node:http";
import fs from "node:fs";

const OUT = "data/harvest";
fs.mkdirSync(OUT, { recursive: true });

http
  .createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") return res.end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const name = `${OUT}/${(new URL(req.url, "http://x").searchParams.get("name") || "drop").replace(/[^\w.-]/g, "")}.json`;
      fs.writeFileSync(name, body);
      console.log(new Date().toISOString(), name, body.length, "bytes");
      res.end(JSON.stringify({ ok: true, name, bytes: body.length }));
    });
  })
  .listen(3300, "127.0.0.1", () => console.log("receiver on 127.0.0.1:3300"));
