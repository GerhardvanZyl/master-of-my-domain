import fs from "node:fs";
import path from "node:path";

/**
 * Side-effect module: loads .env.local then .env into process.env for CLI
 * scripts run via tsx (Next.js loads these automatically, standalone scripts
 * do not). Import this FIRST, before any module that reads process.env.
 */
for (const file of [".env.local", ".env"]) {
  const p = path.resolve(process.cwd(), file);
  if (fs.existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      // ignore malformed/duplicate; later files must not clobber earlier ones
    }
  }
}
