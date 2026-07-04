import { randomUUID } from "node:crypto";

/** Short, prefixed, URL-safe id, e.g. newId("prop") -> "prop_a1b2c3d4e5f6". */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
