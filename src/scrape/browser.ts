import fs from "node:fs";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { CHROMIUM_PATH } from "@/lib/env";

const globalForBrowser = globalThis as unknown as {
  __browser?: Browser;
};

// Common Chromium/Chrome locations, tried when CHROMIUM_PATH isn't a real file.
const CANDIDATE_PATHS = [
  CHROMIUM_PATH,
  "/opt/pw-browsers/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

function resolveChromium(): string {
  for (const p of CANDIDATE_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error(
    "Could not find a Chromium/Chrome binary. Set CHROMIUM_PATH in .env.local " +
      "to your browser executable, or install one (e.g. `npx playwright install chromium`).",
  );
}

/** Launch (or reuse) a single headless Chromium. */
export async function getBrowser(): Promise<Browser> {
  if (globalForBrowser.__browser && globalForBrowser.__browser.isConnected()) {
    return globalForBrowser.__browser;
  }
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  globalForBrowser.__browser = browser;
  return browser;
}

/** A realistic AU browsing context. Caller must close it when done. */
export async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  return browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
    viewport: { width: 1440, height: 900 },
  });
}

export async function closeBrowser(): Promise<void> {
  if (globalForBrowser.__browser) {
    await globalForBrowser.__browser.close().catch(() => {});
    globalForBrowser.__browser = undefined;
  }
}
