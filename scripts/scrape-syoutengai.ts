const BASE = "https://www.syoutengai-sanpo.jp";
const LIST_URL = `${BASE}/list-zenkoku/`;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
console.log(
  process.argv[2]
)
async function fetchHtml(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (res.ok) return await res.text();
    if (attempt >= 3) throw new Error(`HTTP ${res.status}: ${url}`);
    await sleep(attempt * 1000);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function firstHref(html: string): string | undefined {
  const m = html.match(/<a\b[^>]+href="([^"]+)"/i);
  if (!m) return undefined;
  let u = decodeEntities(m[1]!);
  if (u.startsWith("/")) u = BASE + u;
  return u;
}

interface RawCell {
  value: string;
  url?: string;
  rowspan: number;
}

function parseTable(tableHtml: string): { headers: string[]; rows: RawCell[][] } {
  const thead = tableHtml.match(/<thead>([\s\S]*?)<\/thead>/);
  const headers = thead
    ? [...thead[1]!.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => textOf(m[1]!))
    : [];
  const tbody = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/);
  const rows: RawCell[][] = [];
  if (tbody) {
    for (const tr of tbody[1]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells: RawCell[] = [];
      for (const td of tr[1]!.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)) {
        const rs = td[1]!.match(/rowspan="(\d+)"/);
        cells.push({
          value: textOf(td[2]!),
          url: firstHref(td[2]!),
          rowspan: rs ? Number(rs[1]!) : 1,
        });
      }
      rows.push(cells);
    }
  }
  return { headers, rows };
}

function fillRowspan(headers: string[], rows: RawCell[][]): Array<Array<{ value: string; url?: string } | undefined>> {
  const colCount = headers.length || 5;
  const pending = new Array<{ value: string; url?: string; remaining: number } | undefined>(colCount);
  const out: Array<Array<{ value: string; url?: string } | undefined>> = [];
  for (const row of rows) {
    let ci = 0;
    const rec: Array<{ value: string; url?: string } | undefined> = new Array(colCount);
    for (let col = 0; col < colCount; col++) {
      const pend = pending[col];
      if (pend && pend.remaining > 0) {
        pend.remaining--;
        rec[col] = { value: pend.value, url: pend.url };
        continue;
      }
      const cell = row[ci++];
      if (!cell) continue;
      rec[col] = { value: cell.value, url: cell.url };
      if (cell.rowspan > 1) {
        pending[col] = { value: cell.value, url: cell.url, remaining: cell.rowspan - 1 };
      }
    }
    out.push(rec);
  }
  return out;
}

const COLUMN_KEYS = new Map([
  ["市区町村", "city"],
  ["市町村", "city"],
  ["最寄駅/バス停", "station"],
  ["商店街名", "name"],
  ["ステータス", "status"],
  ["備考", "note"],
]);

async function main() {
  const html = await fetchHtml(LIST_URL);
  const seen = new Set<string>();
  const prefs: Array<{ slug: string; name: string; url: string }> = [];
  for (const m of html.matchAll(/<a\b[^>]+href="[^"]*\/list-zenkoku\/list-([a-z]+)\/"[^>]*>([\s\S]*?)<\/a>/g)) {
    const slug = m[1]!;
    if (seen.has(slug)) continue;
    seen.add(slug);
    prefs.push({
      slug,
      name: textOf(m[2]!),
      url: `${BASE}/list-zenkoku/list-${slug}/`,
    });
  }

  const limit = Number(process.env.SYOUTENGAI_LIMIT || 0);
  const results: unknown[] = [];
  for (const [i, pref] of prefs.entries()) {
    if (limit > 0 && i >= limit) break;
    const page = await fetchHtml(pref.url);
    const table = page.match(/<table[^>]*class="[^"]*tablepress[^"]*"[^>]*>[\s\S]*?<\/table>/);
    if (!table) {
      console.warn(`skip (no table): ${pref.name}`);
      continue;
    }
    const { headers, rows } = parseTable(table[0]);
    const nameCol =
      headers.length > 0 && headers.indexOf("商店街名") >= 0
        ? headers.indexOf("商店街名")
        : 2;
    for (const rec of fillRowspan(headers, rows)) {
      if (!rec) continue;
      const name = rec[nameCol];
      if (!name?.value) continue;
      const record: Record<string, string | undefined> = {
        prefecture: pref.name,
        prefectureSlug: pref.slug,
      };
      for (const [col, header] of headers.entries()) {
        const key = COLUMN_KEYS.get(header) ?? `col${col + 1}`;
        const cell = rec[col];
        record[key] = cell?.value;
      }
      record.url = name.url;
      for (const k of Object.keys(record)) {
        if (record[k] === undefined || record[k] === "") delete record[k];
      }
      results.push(record);
    }
    console.error(`done: ${pref.name} (${results.length} total)`);
    await sleep(300);
  }

  const json = JSON.stringify(results, null, 2) + "\n";
  const outPath = process.argv[2];
  if (outPath) await Bun.write(outPath, json);
  else process.stdout.write(json);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
