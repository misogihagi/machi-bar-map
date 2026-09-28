import { chromium, type Page } from "playwright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dir, "..", "data");
const RESULTS_FILE = join(DATA_DIR, "google-search-results.json");
const SOURCE_FILES = [
  "ccisearch-cci.json",
  "ccisearch-foreign.json",
  "ccisearch-overseas.json",
  "shokokai.json",
  "syoutengai.json",
] as const;

interface SearchResult {
  results: {
    title: string;
    link: string | null;
  }[];
  aiOverview: {
    text: string;
    links: string[];
  }
}

interface QueryEntry {
  query: string;
  source: string;
  name: string;
  results: SearchResult | null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

async function isSorryPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("/sorry/")) return true;
  const sorryForm = await page.$('form[action*="sorry"]');
  if (sorryForm) return true;
  const sorryText = await page.$('div:has-text("unusual traffic")');
  if (sorryText) return true;
  return false;
}

async function googleSearch(page: Page, query: string): Promise<SearchResult| null> {
  await page.goto(`https://www.google.com/search?q=${query}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await sleep(3000 + Math.random() * 2000);

  if (await isSorryPage(page)) {
    console.error("  sorry page detected, waiting 10 minutes...");
    await sleep(600_000 + Math.random() * 60_000);
    await page.goto(`https://www.google.com/search?q=${query}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await sleep(3000 + Math.random() * 2000);
    if (await isSorryPage(page)) {
      console.error("  still blocked after wait, skipping query");
      return null;
    }
  }

  await dismissConsent(page);

  await humanScroll(page);

  const links = page.locator("a:has(h3)")
  const count = await links.count()

  const results = await Promise.all(Array.from({ length: Math.min(count, 10) }, (_, i) => links.nth(i))
    .map(async l =>
  ({
    title: await l.locator("h3").innerText(),
    link: await l.getAttribute("href")
    })))


  const aiOverviewText = await page.locator("section").innerText()
  const aiOverviewLinks = await page.locator("section").locator("a").evaluateAll(elements =>
    elements.map(el => (el.href))
  );

  return {results, "aiOverview": {text:aiOverviewText, links:aiOverviewLinks}}
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
  const files: string[] = [...SOURCE_FILES];

  const queries: { query: string; source: string; name: string }[] = [];
  for (const file of files) {
    const data: Record<string, unknown>[] = JSON.parse(
      await readFile(join(DATA_DIR, file), "utf-8"),
    );
    for (const entry of data) {
      const raw = entry.cci_name ?? entry.name;
      if (typeof raw !== "string" || !raw.trim()) continue;
      const name = raw.trim();
      const isCci = file === "ccisearch-cci.json";
      const query = isCci ? `${name}商工会議所 街バル` : `${name} 街バル`;
      queries.push({ query, source: file, name });
    }
  }

  const unique = Array.from(new Map(queries.map((q) => [q.query, q])).values());
  console.error(`Total unique queries: ${unique.length}`);

  const existing = await loadExistingResults();
  const pending = unique.filter((q) => !existing.has(q.query));
  console.error(`Pending: ${pending.length} (skipping ${unique.length - pending.length} already done)`);

  const browser = await chromium.launch({
    headless: false,
  });
  const context = await browser.newContext({
      userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
})
  const page = await context.newPage();

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
