import type { Adapter } from "./base";
import { DomainAdapter } from "./domain";
import { ReaAdapter } from "./rea";

export const ADAPTERS: Adapter[] = [DomainAdapter, ReaAdapter];

export function pickAdapter(input: string): Adapter | null {
  let hostname: string;
  try {
    hostname = new URL(input).hostname;
  } catch {
    return null;
  }
  return ADAPTERS.find((a) => a.matches(hostname)) ?? null;
}

export { ScrapeError } from "./base";
