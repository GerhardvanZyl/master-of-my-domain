import path from "node:path";

/** Absolute project root (this file lives at <root>/src/lib/env.ts). */
export const PROJECT_ROOT = path.resolve(process.cwd());

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

export const DATA_DIR = resolveFromRoot(process.env.DATA_DIR ?? "./data");
export const DB_PATH = resolveFromRoot(process.env.DB_PATH ?? "./data/app.db");
export const IMAGES_DIR = resolveFromRoot(
  process.env.IMAGES_DIR ?? "./data/images",
);
export const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
