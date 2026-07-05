import Link from "next/link";
import type { ScrapeJob } from "@/db/schema";

const GLYPH: Record<string, string> = {
  done: "✓",
  error: "✗",
  running: "•",
  queued: "•",
};
const COLOR: Record<string, string> = {
  done: "text-green-600",
  error: "text-red-600",
  running: "text-blue-600",
  queued: "text-neutral-400",
};

export default function SearchHistory({ jobs }: { jobs: ScrapeJob[] }) {
  if (jobs.length === 0) return null;

  return (
    <details className="rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <summary className="cursor-pointer px-4 py-2 text-sm font-medium">
        Search history ({jobs.length})
      </summary>
      <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
        {jobs.map((j) => (
          <li key={j.id} className="flex items-center gap-3 px-4 py-2 text-sm">
            <span className={COLOR[j.status] ?? "text-neutral-400"}>
              {GLYPH[j.status] ?? "•"}
            </span>
            <a
              href={j.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate text-neutral-600 hover:underline dark:text-neutral-300"
              title={j.url}
            >
              {j.url}
            </a>
            <time className="shrink-0 text-xs text-neutral-400">
              {new Date(j.createdAt).toLocaleString()}
            </time>
            {j.status === "done" && j.propertyId ? (
              <Link
                href={`/property/${j.propertyId}`}
                className="shrink-0 text-xs text-blue-600 hover:underline"
              >
                view
              </Link>
            ) : j.status === "error" ? (
              <span
                className="max-w-[16rem] shrink-0 truncate text-xs text-red-500"
                title={j.error ?? ""}
              >
                {j.error}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
