"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AddLinksForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data.error ?? "Failed to enqueue");
      } else {
        const n = data.jobs.length;
        const unsupported = data.jobs.filter(
          (j: { supported: boolean }) => !j.supported,
        ).length;
        setMsg(
          `Queued ${n} URL${n === 1 ? "" : "s"}` +
            (unsupported ? ` (${unsupported} unsupported site)` : ""),
        );
        setText("");
        router.refresh();
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <label className="mb-2 block text-sm font-medium">
        Paste listing links (Domain or realestate.com.au — one or many)
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="https://www.domain.com.au/...&#10;https://www.realestate.com.au/..."
        className="w-full rounded-md border border-neutral-300 bg-transparent p-2 text-sm dark:border-neutral-700"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={busy || text.trim() === ""}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Scraping…" : "Scrape"}
        </button>
        {msg && <span className="text-sm text-neutral-500">{msg}</span>}
      </div>
    </div>
  );
}
