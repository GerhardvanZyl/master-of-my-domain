import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Run `next dev` and the HTTPS proxy together (npm run dev:https). Ctrl+C — or
// either process dying — stops both. Spawns node directly (no shell / PATH
// guesswork), so it works the same on Windows and *nix.
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const proxy = fileURLToPath(new URL("./https-proxy.mjs", import.meta.url));

const tasks = [
  { name: "dev", argv: [nextBin, "dev", "-p", "3225"] },
  { name: "https", argv: [proxy] },
];

const procs = tasks.map((t) => {
  const p = spawn(process.execPath, t.argv, { stdio: "inherit" });
  p.on("exit", (code) => {
    console.log(`\n[dev:https] "${t.name}" exited (${code ?? "signal"}) — stopping both`);
    stop();
  });
  return p;
});

// On Windows, p.kill() only ends that one PID — `next dev` spawns a worker tree
// that would be orphaned. taskkill /T tears the whole tree down.
const win = process.platform === "win32";
function killTree(p) {
  if (!p.pid) return;
  try {
    if (win) spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) killTree(p);
  setTimeout(() => process.exit(0), 400);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
