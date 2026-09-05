import { chromium } from "playwright";

const SEARCH_PAGE = "https://www.shokokai.or.jp/?page_id=1754";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

interface Shokokai {
  name: string;
  url?: string;
  postalCode?: string;
  address?: string;
  tel?: string;
  fax?: string;
  kencd?: string;
  syocd?: string;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  console.error("Navigating to search page...");
  await page.goto(SEARCH_PAGE, { waitUntil: "networkidle" });

  await page.check('input[name="kencd[]"][value="00"]');
  await page.selectOption('select[name="kensu"]', "ALL");

  console.error("Submitting search for 全国 (ALL)...");
  await page.click('input[name="proc_btn"]');
  await page.waitForSelector("ul.ul_A", { timeout: 60000 });
  console.error("Results loaded.");

  const entries = await page.$$eval("ul.ul_A > li", (lis) =>
    lis.map((li) => {
      const el = li as HTMLElement;
      const nameLink = el.querySelector("a");
      const name = nameLink?.textContent?.trim() || el.textContent?.split(".")[1]?.split("\n")[0]?.trim() || "";
      const url = nameLink?.href;

      const text = el.innerText;
      const postalMatch = text.match(/〒\s*([\d-]+)/);
      const addressMatch = text.match(/住所\s*(.+)/);
      const telMatch = text.match(/TEL\s*([\d-]+)/);
      const faxMatch = text.match(/FAX\s*([\d-]+)/);

      const onclick = el.innerHTML.match(
        /mapGo\('(\d+)',\s*'(\d+)'/,
      );

      return {
        name,
        url,
        postalCode: postalMatch?.[1],
        address: addressMatch?.[1]?.trim(),
        tel: telMatch?.[1],
        fax: faxMatch?.[1],
        kencd: onclick?.[1],
        syocd: onclick?.[2],
      };
    }),
  );

  console.error(`Parsed: ${entries.length} entries`);

  const json = JSON.stringify(entries, null, 2) + "\n";
  const outPath = process.argv[2];
  if (outPath) await Bun.write(outPath, json);
  else process.stdout.write(json);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
