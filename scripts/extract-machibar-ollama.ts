import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dir, "..", "data");
const INPUT_FILE = join(DATA_DIR, "google-search-results.json");
const OUTPUT_CSV = join(DATA_DIR, "machibar-extracted.csv");
const PROGRESS_FILE = join(DATA_DIR, ".machibar-progress.json");

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = process.env.OLLAMA_MODEL || "qwen3.5:9b";

// ---------- types ----------

interface SearchResultEntry {
  query: string;
  source: string;
  name: string;
  results: {
    results: { title: string; link: string | null }[];
    aiOverview: { text: string; links: string[] } | null;
  } | null;
}

interface RawBarItem {
  has_bar?: boolean;
  bar_name?: string;
  official_url?: string;
  sns?: string;
  last_held_date?: string;
  next_date?: string;
  next_venue?: string;
  lat?: string | number;
  lng?: string | number;
}

interface ExtractedBar {
  query: string;
  source: string;
  searchName: string;
  hasBar: boolean;
  barName: string;
  officialUrl: string;
  sns: string;
  lastHeldDate: string;
  nextDate: string;
  nextVenue: string;
  lat: string;
  lng: string;
}

// ---------- prompt ----------

const SYSTEM_PROMPT = `あなたは日本の街バル・はしご酒イベント情報抽出アシスタントです。
与えられたGoogle検索結果（タイトル・URL一覧とAI Overviewの解説文）から、街バル・バル街イベントの情報を抽出し、必ず指定のJSONフォーマットのみを出力してください。解説やマークダウンの補足は一切不要です。

【判定基準】
- 「街バル」「バル街」「まちバル」「ちょい飲み」「はしご酒イベント」等、複数店舗を食べ飲み歩き・巡回する地域グルメイベントが存在するか判定。
- 単一の飲食店（例:「バル○○」という居酒屋単体）や熱気球の「バルーンフェスタ」等は除外（has_bar: false）。
- イベントが複数言及されている場合は、配列に複数含めてください。
- 座標（lat, lng）が不明な場合は空文字にしてください。

【出力JSON形式】
{
  "bars": [
    {
      "has_bar": true,
      "bar_name": "イベント名",
      "official_url": "公式サイトURL（なければ空文字）",
      "sns": "SNSアカウントURL（なければ空文字）",
      "last_held_date": "直近・最後に開催された日または時期（例: 2026-09-06 または 2026年9月。不明なら空文字）",
      "next_date": "次回開催日（不明なら空文字）",
      "next_venue": "開催エリア・会場・駅名など（不明なら空文字）",
      "lat": "開催地の緯度（不明なら空文字）",
      "lng": "開催地の経度（不明なら空文字）"
    }
  ]
}

街バルが存在しない場合:
{
  "bars": [
    {
      "has_bar": false,
      "bar_name": "",
      "official_url": "",
      "sns": "",
      "last_held_date": "",
      "next_date": "",
      "next_venue": "",
      "lat": "",
      "lng": ""
    }
  ]
}`;

function buildUserPrompt(entry: SearchResultEntry): string {
  const parts: string[] = [];
  parts.push(`検索クエリ: ${entry.query}`);
  parts.push(`団体名: ${entry.name}`);

  const r = entry.results;
  if (r?.results?.length) {
    parts.push("\n## 検索結果一覧（上位）");
    for (const item of r.results.slice(0, 8)) {
      parts.push(`- ${item.title}  ${item.link ?? ""}`);
    }
  }

  if (r?.aiOverview?.text) {
    parts.push("\n## AI Overview");
    // CPU負荷軽減のため、長すぎるテキストは先頭2500文字程度に制限
    const text = r.aiOverview.text.length > 2500
      ? r.aiOverview.text.slice(0, 2500) + "\n...（以下省略）"
      : r.aiOverview.text;
    parts.push(text);

    if (r.aiOverview.links?.length) {
      parts.push("\n参照リンク:");
      for (const link of r.aiOverview.links.slice(0, 8)) {
        parts.push(`- ${link}`);
      }
    }
  }

  return parts.join("\n");
}

// ---------- ollama ----------

async function callOllama(userPrompt: string): Promise<string> {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    stream: false,
    think: false, // qwen3.5 の thinking モードを無効化（CPU推論高速化）
    options: {
      temperature: 0.1,
      num_predict: 1024,
    },
  };

  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { message: { content: string } };
  return data.message.content;
}

function parseResponse(raw: string): RawBarItem[] {
  // ```json ... ``` ブロックがあれば優先して抜き出す
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const targetText = codeBlockMatch ? codeBlockMatch[1] : raw;

  const jsonMatch = targetText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in response: ${raw.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.bars || !Array.isArray(parsed.bars)) {
    // bars キーではなく配列自体またはオブジェクト単体の場合のフォールバック
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "object" && "has_bar" in parsed) return [parsed];
    throw new Error(`Invalid response structure: ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  return parsed.bars;
}

// ---------- progress / CSV ----------

async function loadProgress(): Promise<Set<string>> {
  try {
    const data = JSON.parse(await Bun.file(PROGRESS_FILE).text());
    return new Set(data);
  } catch {
    return new Set();
  }
}

async function saveProgress(done: Set<string>) {
  await Bun.write(PROGRESS_FILE, JSON.stringify([...done]));
}

const CSV_HEADER = [
  "query",
  "source",
  "search_name",
  "has_bar",
  "bar_name",
  "official_url",
  "sns",
  "last_held_date",
  "next_date",
  "next_venue",
  "lat",
  "lng",
].join(",");

function escCsv(s: string): string {
  if (s == null) return "";
  const str = String(s);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCSVRow(bar: ExtractedBar): string {
  return [
    bar.query,
    bar.source,
    bar.searchName,
    bar.hasBar ? "TRUE" : "FALSE",
    bar.barName,
    bar.officialUrl,
    bar.sns,
    bar.lastHeldDate,
    bar.nextDate,
    bar.nextVenue,
    bar.lat,
    bar.lng,
  ]
    .map(escCsv)
    .join(",");
}

// ---------- main ----------

async function main() {
  const limit = Number(process.env.LIMIT || 0);

  console.error(`=== 街バル抽出スクリプト (Ollama) ===`);
  console.error(`モデル: ${MODEL}`);
  console.error(`データ読み込み中: ${INPUT_FILE}...`);

  const allEntries: SearchResultEntry[] = JSON.parse(
    await Bun.file(INPUT_FILE).text(),
  );
  console.error(`総件数: ${allEntries.length}`);

  // 有効なデータを持つエントリをフィルタ
  const validEntries = allEntries.filter(
    (e) =>
      e.results &&
      typeof e.results === "object" &&
      (e.results.results?.length || e.results.aiOverview),
  );
  console.error(`検索データが存在する件数: ${validEntries.length}`);

  // 進捗読み込み
  const done = await loadProgress();
  const pending = validEntries.filter((e) => !done.has(e.query));
  console.error(`完了済み: ${done.size}, 未処理: ${pending.length}`);

  if (limit > 0) {
    console.error(`LIMIT指定: 先頭 ${limit} 件を処理します`);
    pending.splice(limit);
  }

  // CSVの初期化
  const csvFile = Bun.file(OUTPUT_CSV);
  if (!(await csvFile.exists())) {
    await appendFile(OUTPUT_CSV, CSV_HEADER + "\n");
  }

  const startTime = Date.now();
  let processed = 0;
  let errors = 0;
  let foundBars = 0;

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    const userPrompt = buildUserPrompt(entry);

    try {
      const raw = await callOllama(userPrompt);
      const items = parseResponse(raw);

      const rows: ExtractedBar[] = items.map((bar) => ({
        query: entry.query,
        source: entry.source,
        searchName: entry.name,
        hasBar: !!bar.has_bar,
        barName: bar.bar_name || "",
        officialUrl: bar.official_url || "",
        sns: bar.sns || "",
        lastHeldDate: bar.last_held_date || "",
        nextDate: bar.next_date || "",
        nextVenue: bar.next_venue || "",
        lat: bar.lat != null ? String(bar.lat) : "",
        lng: bar.lng != null ? String(bar.lng) : "",
      }));

      for (const row of rows) {
        await appendFile(OUTPUT_CSV, toCSVRow(row) + "\n");
        if (row.hasBar) foundBars++;
      }
      processed++;
    } catch (err) {
      errors++;
      console.error(`  [ERROR] ${entry.query}: ${err}`);

      // エラー時のフォールバック行を出力
      const fallbackRow: ExtractedBar = {
        query: entry.query,
        source: entry.source,
        searchName: entry.name,
        hasBar: false,
        barName: "ERROR",
        officialUrl: "",
        sns: "",
        lastHeldDate: "",
        nextDate: "",
        nextVenue: "",
        lat: "",
        lng: "",
      };
      await appendFile(OUTPUT_CSV, toCSVRow(fallbackRow) + "\n");
      processed++;
    }

    done.add(entry.query);

    // 5件ごと、または最後に進捗を保存
    if (processed % 5 === 0 || i === pending.length - 1) {
      await saveProgress(done);
    }

    // 進捗ログ
    const elapsedSec = (Date.now() - startTime) / 1000;
    const rate = processed / elapsedSec;
    const remaining = pending.length - processed;
    const etaSec = rate > 0 ? remaining / rate : 0;
    const etaMin = Math.floor(etaSec / 60);

    console.error(
      `[${i + 1}/${pending.length}] ` +
        `処理: ${processed} | 街バル検出: ${foundBars} | エラー: ${errors} | ` +
        `${(1 / rate).toFixed(1)}s/件 | 残りETA: 約${etaMin}分`,
    );
  }

  await saveProgress(done);

  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.error(`\n=== 完了 ===`);
  console.error(`処理件数: ${processed} 件 (エラー: ${errors})`);
  console.error(`街バル検出数: ${foundBars} 件`);
  console.error(`総所要時間: ${totalMin} 分`);
  console.error(`出力先: ${OUTPUT_CSV}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
