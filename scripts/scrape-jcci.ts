import { chromium } from "playwright";

const SEARCH_URL = "https://ccisearch.jcci.or.jp/data";

const DATASETS = [
  { url: `${SEARCH_URL}/cci.json`, file: "ccisearch-cci.json", label: "domestic CCI" },
  { url: `${SEARCH_URL}/cci_oversea.json`, file: "ccisearch-overseas.json", label: "overseas CCI" },
  { url: `${SEARCH_URL}/foreign_cci.json`, file: "ccisearch-foreign.json", label: "foreign CCI" },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const outDir = process.argv[2] || ".";

  for (const { url, file, label } of DATASETS) {
    console.error(`Fetching ${label}...`);
    const response = await page.goto(url, { waitUntil: "networkidle" });
    const text = await response!.text();
    const data = JSON.parse(text);
    const outPath = `${outDir}/${file}`;
    await Bun.write(outPath, JSON.stringify(data, null, 2) + "\n");
    console.error(`  ${data.length} entries -> ${outPath}`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
