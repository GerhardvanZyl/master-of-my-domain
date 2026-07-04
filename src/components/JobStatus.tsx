"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Job {
  id: string;
  url: string;
  status: string;
  error: string | null;
}

export default function JobStatus() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const wasActive = useRef(false);

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const res = await fetch("/api/jobs", { cache: "no-store" });
        const data = await res.json();
        if (stop) return;
        setJobs(data.jobs);
        // When activity transitions from active -> idle, refresh the grid.
        if (wasActive.current && !data.active) router.refresh();
        wasActive.current = data.active;
      } catch {
        /* ignore transient */
      }
    }
    poll();
    const t = setInterval(poll, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [router]);

  const active = jobs.filter(
    (j) => j.status === "queued" || j.status === "running",
  );
  const recentErrors = jobs.filter((j) => j.status === "error").slice(0, 3);

  if (active.length === 0 && recentErrors.length === 0) return null;

  return (
    <div className="space-y-1 text-sm">
      {active.map((j) => (
        <div key={j.id} className="flex items-center gap-2 text-blue-600">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-600" />
          <span className="truncate">
            {j.status === "running" ? "Scraping" : "Queued"}: {j.url}
          </span>
        </div>
      ))}
      {recentErrors.map((j) => (
        <div key={j.id} className="text-red-600">
          ✗ {j.url} — {j.error}
        </div>
      ))}
    </div>
  );
}
