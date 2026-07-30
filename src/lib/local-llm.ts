import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE = "http://127.0.0.1:1234/v1";

export interface AskLocalOptions {
  model: string;
  prompt: string;
  system?: string;
  /** Absolute path to an image to attach. Omit for text-only calls. */
  imagePath?: string;
  /** JSON Schema the reply must satisfy — the server enforces it. */
  schema: Record<string, unknown>;
  schemaName?: string;
  /** Defaults to $LOCAL_LLM_URL, then http://127.0.0.1:1234/v1. */
  baseUrl?: string;
  timeoutMs?: number;
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function dataUrl(p: string): string {
  const mime = MIME[path.extname(p).toLowerCase()] ?? "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(p).toString("base64")}`;
}

/**
 * One call to a local OpenAI-compatible server (LM Studio by default).
 * Returns the parsed JSON reply. Throws with an actionable message on any
 * failure — callers decide whether to skip the item or abort the run.
 */
export async function askLocal(opts: AskLocalOptions): Promise<unknown> {
  const base = opts.baseUrl ?? process.env.LOCAL_LLM_URL ?? DEFAULT_BASE;
  const content: unknown[] = [{ type: "text", text: opts.prompt }];
  if (opts.imagePath) {
    content.push({
      type: "image_url",
      image_url: { url: dataUrl(opts.imagePath) },
    });
  }

  const body = {
    model: opts.model,
    temperature: 0,
    messages: [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: opts.schemaName ?? "reply",
        strict: true,
        schema: opts.schema,
      },
    },
  };

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Local model server not reachable at ${base} — is LM Studio's server running with a model loaded? (${why})`,
    );
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(`Local model server returned ${res.status}: ${detail}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("Local model returned no message content");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Local model reply was not JSON: ${text.slice(0, 200)}`);
  }
}
