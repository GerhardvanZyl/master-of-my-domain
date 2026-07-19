import { sqlite } from "./client";
import { DDL, migrateColumns } from "./ddl";

/**
 * Idempotent schema creation via `CREATE TABLE IF NOT EXISTS` (executed through
 * better-sqlite3) rather than drizzle-kit codegen — the schema is small and
 * this keeps migrations dependency-free and re-runnable. client.ts also applies
 * this DDL automatically on connect.
 */
export function migrate(): void {
  sqlite.exec(DDL);
  migrateColumns(sqlite);
}
