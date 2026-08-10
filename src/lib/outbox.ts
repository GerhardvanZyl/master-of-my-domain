/**
 * Offline outbox: notes and photos captured with no connection are parked in
 * IndexedDB and replayed against the API once the server is reachable again.
 *
 * ponytail: raw IndexedDB, one auto-increment store, no `idb` dependency and no
 * Background Sync API — Background Sync doesn't exist on iOS Safari, which is
 * the phone this actually gets used on, so the flush is driven from the page
 * (mount + `online` event + the manual button in SyncStatus). Upgrade path if
 * that ever stops being enough: register a 'sync' tag in the service worker for
 * the browsers that do support it, keeping this as the fallback.
 */

export type Job =
  | { kind: "notes"; propertyId: string; text: string }
  | { kind: "media"; propertyId: string; name: string; type: string; blob: Blob };

/** A job as stored, with the key IndexedDB assigned it. */
export type StoredJob = Job & { id: number; queuedAt: string };

const DB_NAME = "pc-outbox";
const STORE = "queue";
/** Fired on the window whenever the queue length changes. */
export const OUTBOX_EVENT = "outbox-change";

// --- replay (pure — no IndexedDB, so it's testable in Node) -----------------

/** The request a job replays as. Split out so tests can assert it without a DB. */
export function jobRequest(job: Job): { url: string; init: RequestInit } {
  const id = encodeURIComponent(job.propertyId);
  if (job.kind === "notes") {
    return {
      url: `/api/properties/${id}/notes`,
      init: {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domainNotes: job.text }),
      },
    };
  }
  const form = new FormData();
  form.append("files", new File([job.blob], job.name, { type: job.type }));
  return { url: `/api/properties/${id}/media`, init: { method: "POST", body: form } };
}

export type Outcome = "done" | "retry" | "drop";

/**
 * Replay one job. `drop` means the server rejected it in a way that will never
 * change (bad id, unsupported file type) — keeping it would block the queue
 * forever. `retry` means the server or the network was unavailable.
 */
export async function replay(
  job: Job,
  fetchFn: typeof fetch = fetch,
): Promise<Outcome> {
  let res: Response;
  try {
    const { url, init } = jobRequest(job);
    res = await fetchFn(url, init);
  } catch {
    return "retry"; // still offline
  }
  if (res.ok) return "done";
  return res.status >= 500 ? "retry" : "drop";
}

// --- store ------------------------------------------------------------------

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = fn(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

function announce() {
  window.dispatchEvent(new CustomEvent(OUTBOX_EVENT));
}

export async function allJobs(): Promise<StoredJob[]> {
  try {
    const jobs = await tx<StoredJob[]>("readonly", (s) => s.getAll() as IDBRequest<StoredJob[]>);
    return jobs.sort((a, b) => a.id - b.id);
  } catch {
    return []; // private mode / no IndexedDB — the app still works online
  }
}

/** Queue a job. Notes are last-write-wins: a newer note replaces any pending one. */
export async function queue(job: Job): Promise<void> {
  if (job.kind === "notes") {
    for (const old of await allJobs()) {
      if (old.kind === "notes" && old.propertyId === job.propertyId) await remove(old.id);
    }
  }
  await tx("readwrite", (s) => s.add({ ...job, queuedAt: new Date().toISOString() }));
  announce();
}

async function remove(id: number): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

/** Photos still waiting to upload for one property, oldest first. */
export async function pendingMedia(propertyId: string) {
  return (await allJobs()).filter(
    (j): j is StoredJob & { kind: "media" } => j.kind === "media" && j.propertyId === propertyId,
  );
}

let flushing = false;

/**
 * Replay the queue oldest-first, stopping at the first job that needs a retry
 * so ordering (and last-write-wins on notes) is preserved. Returns how many
 * jobs left the queue, so callers know whether to refresh the page data.
 */
export async function flush(): Promise<{ sent: number; dropped: number; left: number }> {
  if (flushing) return { sent: 0, dropped: 0, left: (await allJobs()).length };
  flushing = true;
  let sent = 0;
  let dropped = 0;
  try {
    const jobs = await allJobs();
    for (const job of jobs) {
      const outcome = await replay(job);
      if (outcome === "retry") break;
      await remove(job.id);
      if (outcome === "done") sent++;
      else dropped++;
    }
  } finally {
    flushing = false;
  }
  if (sent || dropped) announce();
  return { sent, dropped, left: (await allJobs()).length };
}
