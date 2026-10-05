import { chromium, type Page } from "playwright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dir, "..", "data");
const RESULTS_FILE = join(DATA_DIR, "google-search-results.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
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
  } | null;
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

const resolvedUrlCache = new Map<string, string>();
const isGoogleRedirect = (url: string) =>
  /^https?:\/\/(?:[a-z]+\.)?google\.[a-z.]+\/(?:goto|url)\?/.test(url);

function extractTargetUrl(url: string): string | null {
  if (!isGoogleRedirect(url)) return null;
  const target = new URL(url).searchParams.get("url");
  if (!target) return null;
  const decoded = decodeURIComponent(target);
  if (/^https?:\/\//i.test(decoded)) return decoded;
  return null;
}

async function resolveGoogleUrl(url: string): Promise<string> {
  const direct = extractTargetUrl(url);
  if (direct) return direct;
//  if (!isGoogleRedirect(url)) return url;
  const cached = resolvedUrlCache.get(url);
  if (cached) return cached;

  let resolved = url;
  try {
    const res = await fetch(url.startsWith("/") ? "https://www.google.com" + url : url, {
      redirect: "manual",
      headers: { "user-agent": UA, referer: "https://www.google.com/", "accept-language": "ja" },
    });
    const location = res.headers.get("location");
    if (location) {
      return location
      resolved = new URL(location, url).href;
    } else {
      const body = await res.text();
      const found =
        body.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+url=([^"'\s>]+)/i)?.[1] ??
        body.match(/<meta[^>]+content=["'][^"']*url=([^"'\s>]+)/i)?.[1] ??
        body.match(/URL=["']([^"']+)["']/i)?.[1] ??
        body.match(/location\.replace\(["']([^"']+)["']\)/)?.[1];
      if (found) resolved = new URL(decodeURIComponent(found.replace(/&amp;/g, "&")), url).href;
    }
  } catch (err) {
    console.error(`  failed to resolve ${url}: ${err}`);
  }

  resolvedUrlCache.set(url, resolved);
  await sleep(300);
  return resolved;
}

async function googleSearch(page: Page, query: string): Promise<SearchResult| null> {
  await page.goto(`https://www.google.com/search?q=${query}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await sleep(10000 + Math.random() * 2000);

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

  const titles = page.locator("a > h3")
  const cites = page.locator('a > h3').locator('..');
  const count = Math.min(await titles.count(), await cites.count(), 10)

  const results = await Promise.all(Array.from({ length: count }, async (_, i) => {
    const href = await cites.nth(i).getAttribute("href");
    return {
      title: await titles.nth(i).innerText(),
      link: href ? await resolveGoogleUrl(href) : null,
    };
  }))


  const aiOverview = page.locator("div + div > div > div > div > div > div > div > div > div > section")
  if ((await aiOverview.count()) === 0) {
    console.error("  ai overview not found")
    return {results, aiOverview: null}
  }

  const aiOverviewText = await aiOverview.first().innerText()
  const aiOverviewLinks: string[] = []
  for (const href of await aiOverview.first().locator("a").evaluateAll(elements =>
    elements.map(el => (el.href))
  )) {
    aiOverviewLinks.push(await resolveGoogleUrl(href))
  }

  return {results, aiOverview: {text:aiOverviewText, links:aiOverviewLinks}}
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
      const isCci = file === "ccisearch-cci.json";
      
      // (一社)となっているものは商工会議所ではなく商工会議所連合会
      const isFederation = /^[(（]一社[)）]/.test(raw);
      const name = raw.trim();
      const query = isFederation
        ? `${name.replace(/^[(（]一社[)）]\s*/, "")}商工会議所連合会 街バル` :
        isCci ?
        `${name}商工会議所 街バル` :
        `${name} 街バル`;
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
      userAgent: UA
})
  const page = await context.newPage();

  let done = 0;
  for (const { query, source, name } of pending) {
    if (limit > 0 && done >= limit) break;

    console.error(`[${done + 1}/${pending.length}] ${query}`);
    const results = await googleSearch(page, query);

    existing.set(query, { query, source, name, results });
    done++;

    if (done % 3 === 0) {
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
