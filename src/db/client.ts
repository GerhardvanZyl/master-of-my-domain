import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { DATA_DIR, DB_PATH, IMAGES_DIR } from "@/lib/env";
import * as schema from "./schema";
import { DDL, migrateColumns } from "./ddl";

function ensureDirs() {
  for (const dir of [DATA_DIR, IMAGES_DIR, path.dirname(DB_PATH)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Reuse a single connection across the Next.js dev server's hot reloads.
const globalForDb = globalThis as unknown as {
  __sqlite?: Database.Database;
};

function createConnection(): Database.Database {
  ensureDirs();
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(DDL); // ensure schema exists on every fresh connection
  migrateColumns(db); // retrofit added columns onto older DBs
  return db;
}

export const sqlite: Database.Database =
  globalForDb.__sqlite ?? (globalForDb.__sqlite = createConnection());

export const db = drizzle(sqlite, { schema });
export { schema };
