import { chromium, type Page } from "playwright";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dir, "..", "data");
const RESULTS_FILE = join(DATA_DIR, "google-search-results.json");

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

interface QueryEntry {
  query: string;
  source: string;
  name: string;
  results: SearchResult[];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractName(entry: Record<string, unknown>, filename: string): string | undefined {
  if ("cci_name" in entry && typeof entry.cci_name === "string") {
    return entry.cci_name
      .replace(/^\s*[（(]一社[)）]\s*/, "")
      .replace(/^\s*在日\s*/, "")
      .replace(/^\s*日本\s*/, "")
      .replace(/\s*商工会議所$/, "")
      .replace(/\s*商工会$/, "")
      .replace(/\s*商業会議所$/, "")
      .trim() || undefined;
  }
  if ("name" in entry && typeof entry.name === "string") {
    if (filename === "syoutengai.json") return entry.name as string;
    if (filename === "shokokai.json") {
      return (entry.name as string)
        .replace(/\s*商工会連合会$/, "")
        .replace(/\s*商工会$/, "")
        .replace(/\s*商工会議所$/, "")
        .replace(/\s*商工会議所連合会$/, "")
        .trim() || undefined;
    }
  }
  return undefined;
}

async function dismissConsent(page: Page) {
  const consentBtn = await page.$('button:has-text("同意"), button:has-text("Accept"), form[action*="sorry"] input[type="submit"]');
  if (consentBtn) {
    await consentBtn.click();
    await sleep(1000);
  }
}

async function humanScroll(page: Page) {
  await page.mouse.wheel(0, 100 + Math.random() * 200);
  await sleep(200 + Math.random() * 300);
}

async function googleSearch(page: Page, query: string): Promise<SearchResult[]> {
  await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=ja&num=5`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await sleep(60000 + Math.random() * 1200);
  await dismissConsent(page);

  await humanScroll(page);

  const results = await page.$$eval("div.g", (divs) =>
    divs.slice(0, 5).map((div) => {
      const titleEl = div.querySelector("h3");
      const linkEl = div.querySelector("a[href]");
      const snippetEl = div.querySelector(
        'div[data-sncf], div.VwiC3b, div[style*="-webkit-line-clamp"]',
      );
      return {
        title: titleEl?.textContent?.trim() || "",
        link: linkEl?.getAttribute("href") || "",
        snippet: snippetEl?.textContent?.trim() || "",
      };
    }),
  );

  return results.filter((r) => r.link && r.title);
}

async function loadExistingResults(): Promise<Map<string, QueryEntry>> {
  const map = new Map<string, QueryEntry>();
  try {
    const data = JSON.parse(await readFile(RESULTS_FILE, "utf-8"));
    for (const entry of data) map.set(entry.query, entry);
  } catch {}
  return map;
}

async function main() {
  const limit = Number(process.env.LIMIT || 0);
  const files = (await readdir(DATA_DIR)).filter(
    (f) => f.endsWith(".json") && f !== "google-search-results.json",
  );

  const queries: { query: string; source: string; name: string }[] = [];
  for (const file of files) {
    const data: Record<string, unknown>[] = JSON.parse(
      await readFile(join(DATA_DIR, file), "utf-8"),
    );
    for (const entry of data) {
      const name = extractName(entry, file);
      if (!name) continue;
      queries.push({ query: `${name} 街バル`, source: file, name });
    }
  }

  const unique = Array.from(new Map(queries.map((q) => [q.query, q])).values());
  console.error(`Total unique queries: ${unique.length}`);

  const existing = await loadExistingResults();
  const pending = unique.filter((q) => !existing.has(q.query));
  console.error(`Pending: ${pending.length} (skipping ${unique.length - pending.length} already done)`);

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });

  await page.goto("https://www.google.com", { waitUntil: "domcontentloaded" });
  await dismissConsent(page);
  await sleep(1500);

  let done = 0;
  for (const { query, source, name } of pending) {
    if (limit > 0 && done >= limit) break;

    console.error(`[${done + 1}/${pending.length}] ${query}`);
    const results = await googleSearch(page, query);

    existing.set(query, { query, source, name, results });
    done++;

    if (done % 20 === 0) {
      await Bun.write(RESULTS_FILE, JSON.stringify(Array.from(existing.values()), null, 2) + "\n");
      console.error(`  checkpoint saved`);
    }

    await sleep(3000 + Math.random() * 5000);
  }

  await Bun.write(RESULTS_FILE, JSON.stringify(Array.from(existing.values()), null, 2) + "\n");
  console.error(`Done. ${done} new queries. Total: ${existing.size}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
