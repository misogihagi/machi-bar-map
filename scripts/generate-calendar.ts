import fs from "node:fs";
import path from "node:path";

export interface MachibarRawRow {
  query: string;
  source: string;
  search_name: string;
  has_bar: string;
  bar_name: string;
  official_url: string;
  sns: string;
  last_held_date: string;
  next_start_date: string;
  next_end_date: string;
  next_venue: string;
  lat: string;
  lng: string;
}

export interface ParsedEventDate {
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null;   // YYYY-MM-DD
  startTime?: string | null;// HH:MM
  endTime?: string | null;  // HH:MM
  isApproximate: boolean;   // true if month-only or vague
  rawDateString: string;
}

export interface CalendarEvent {
  id: string;
  barName: string;
  searchName: string;
  query: string;
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null;   // YYYY-MM-DD
  startTime?: string | null;
  endTime?: string | null;
  rawStartDate: string;
  rawEndDate: string;
  isApproximate: boolean;
  status: "scheduled" | "approximate" | "past_only" | "unknown";
  venue: string;
  officialUrl: string;
  sns: string;
  lastHeldDate: string;
  lat?: number | null;
  lng?: number | null;
  prefecture?: string;
}

// Simple robust CSV parser handling quotes and newlines
export function parseCSV(text: string): MachibarRawRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
    } else if ((c === "\r" || c === "\n") && !inQuotes) {
      if (c === "\r" && next === "\n") i++;
      row.push(field.trim());
      field = "";
      if (row.length > 1) {
        rows.push(row);
      }
      row = [];
    } else {
      field += c;
    }
  }

  if (field || row.length > 0) {
    row.push(field.trim());
    if (row.length > 1) rows.push(row);
  }

  if (rows.length === 0) return [];

  const headers = rows[0];
  const dataRows = rows.slice(1);

  return dataRows.map((r) => {
    return {
      query: r[0] || "",
      source: r[1] || "",
      search_name: r[2] || "",
      has_bar: r[3] || "",
      bar_name: r[4] || "",
      official_url: r[5] || "",
      sns: r[6] || "",
      last_held_date: r[7] || "",
      next_start_date: r[8] || "",
      next_end_date: r[9] || "",
      next_venue: r[10] || "",
      lat: r[11] || "",
      lng: r[12] || "",
    };
  });
}

// Helper to extract prefecture from venue or search_name or query
const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"
];

function detectPrefecture(venue: string, searchName: string, query: string): string {
  const combined = `${venue} ${searchName} ${query}`;
  for (const pref of PREFECTURES) {
    if (combined.includes(pref)) return pref;
    // Check without '都','府','県' except for 1-character stems
    const shortName = pref.replace(/[都府県]$/, "");
    if (shortName.length >= 2 && combined.includes(shortName)) return pref;
  }
  return "";
}

// Normalize dates: converts various date formats into { YYYY-MM-DD, HH:MM, isApproximate }
export function parseDateString(rawStr: string): { date: string | null; time: string | null; isApproximate: boolean } {
  if (!rawStr || !rawStr.trim()) {
    return { date: null, time: null, isApproximate: false };
  }

  const str = rawStr.trim();

  // Pattern 1: YYYY-MM-DD HH:MM (e.g. 2026-10-10 17:00)
  const ymdHmMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (ymdHmMatch) {
    const y = ymdHmMatch[1];
    const m = ymdHmMatch[2].padStart(2, "0");
    const d = ymdHmMatch[3].padStart(2, "0");
    const hh = ymdHmMatch[4].padStart(2, "0");
    const mm = ymdHmMatch[5];
    return { date: `${y}-${m}-${d}`, time: `${hh}:${mm}`, isApproximate: false };
  }

  // Pattern 2: YYYY-MM-DD or YYYY/MM/DD
  const ymdMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymdMatch) {
    const y = ymdMatch[1];
    const m = ymdMatch[2].padStart(2, "0");
    const d = ymdMatch[3].padStart(2, "0");
    return { date: `${y}-${m}-${d}`, time: null, isApproximate: false };
  }

  // Pattern 3: YYYY年MM月DD日 (e.g. 2026年11月1日)
  const jpYmdMatch = str.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (jpYmdMatch) {
    const y = jpYmdMatch[1];
    const m = jpYmdMatch[2].padStart(2, "0");
    const d = jpYmdMatch[3].padStart(2, "0");
    return { date: `${y}-${m}-${d}`, time: null, isApproximate: false };
  }

  // Pattern 4: YYYY-MM or YYYY/MM or YYYY年MM月 (month only)
  const ymMatch = str.match(/(\d{4})[-/年]\s*(\d{1,2})(?:月)?/);
  if (ymMatch) {
    const y = ymMatch[1];
    const m = ymMatch[2].padStart(2, "0");
    return { date: `${y}-${m}-01`, time: null, isApproximate: true };
  }

  // Pattern 5: Approximate / vague text containing year
  return { date: null, time: null, isApproximate: true };
}

// Convert event list to RFC 5545 iCalendar format
export function generateICalendar(events: CalendarEvent[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Machi-Bar Map//Machi-Bar Calendar//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:街バル開催カレンダー (街バルマップ)",
    "X-WR-TIMEZONE:Asia/Tokyo",
    "X-WR-CALDESC:全国の街バル・はしご酒イベントの開催スケジュール一覧",
  ];

  const now = new Date();
  const dtstamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  // Only include events with valid startDate
  const validEvents = events.filter((e) => e.startDate);

  for (const ev of validEvents) {
    const startStr = ev.startDate!.replace(/-/g, "");
    let endStr = ev.endDate ? ev.endDate.replace(/-/g, "") : startStr;

    // For full-day events, DTEND in iCalendar is exclusive (day after last day)
    let dtStartLine = "";
    let dtEndLine = "";

    if (ev.startTime) {
      const st = ev.startTime.replace(":", "") + "00";
      dtStartLine = `DTSTART:${startStr}T${st}`;
      if (ev.endTime) {
        const et = ev.endTime.replace(":", "") + "00";
        dtEndLine = `DTEND:${endStr}T${et}`;
      } else {
        // default 2-hour duration if end time not specified
        const hour = parseInt(ev.startTime.split(":")[0], 10);
        const nextHour = String(Math.min(23, hour + 2)).padStart(2, "0");
        const et = `${nextHour}${ev.startTime.split(":")[1]}00`;
        dtEndLine = `DTEND:${startStr}T${et}`;
      }
    } else {
      // All day event: add 1 day to end date
      const endYear = parseInt(endStr.substring(0, 4), 10);
      const endMonth = parseInt(endStr.substring(4, 6), 10) - 1;
      const endDay = parseInt(endStr.substring(6, 8), 10);
      const nextDay = new Date(Date.UTC(endYear, endMonth, endDay + 1));
      const nextDayStr = nextDay.toISOString().substring(0, 10).replace(/-/g, "");

      dtStartLine = `DTSTART;VALUE=DATE:${startStr}`;
      dtEndLine = `DTEND;VALUE=DATE:${nextDayStr}`;
    }

    const descriptionParts = [];
    if (ev.isApproximate) {
      descriptionParts.push(`【開催時期目安】${ev.rawStartDate || ""}`);
    }
    if (ev.venue) descriptionParts.push(`会場: ${ev.venue}`);
    if (ev.searchName) descriptionParts.push(`地域/主催: ${ev.searchName}`);
    if (ev.officialUrl) descriptionParts.push(`公式サイト: ${ev.officialUrl}`);
    if (ev.sns) descriptionParts.push(`SNS: ${ev.sns}`);
    if (ev.lastHeldDate) descriptionParts.push(`前回開催: ${ev.lastHeldDate}`);

    const escapeIcs = (str: string) =>
      str.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

    const description = escapeIcs(descriptionParts.join("\n"));
    const summary = escapeIcs(ev.isApproximate ? `[予定] ${ev.barName}` : ev.barName);
    const location = escapeIcs(ev.venue || ev.searchName || "");

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.id}@machibar.map`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(dtStartLine);
    lines.push(dtEndLine);
    lines.push(`SUMMARY:${summary}`);
    if (location) lines.push(`LOCATION:${location}`);
    if (description) lines.push(`DESCRIPTION:${description}`);
    if (ev.officialUrl) lines.push(`URL:${ev.officialUrl}`);
    lines.push("STATUS:CONFIRMED");
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// Main execution
export async function main() {
  const rootDir = process.cwd();
  const csvPath = path.join(rootDir, "data", "machibar-extracted.csv");

  if (!fs.existsSync(csvPath)) {
    console.error(`Error: ${csvPath} not found.`);
    process.exit(1);
  }

  console.log(`Reading CSV: ${csvPath}...`);
  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCSV(csvContent);
  console.log(`Parsed ${rows.length} total rows from CSV.`);

  const barRows = rows.filter(
    (r) => r.has_bar === "TRUE" && r.bar_name && r.bar_name !== "ERROR"
  );
  console.log(`Found ${barRows.length} rows with has_bar === TRUE.`);

  // Group and de-duplicate by bar_name + next_start_date
  const eventMap = new Map<string, CalendarEvent>();

  let counter = 0;
  for (const r of barRows) {
    const rawStart = r.next_start_date.trim();
    const rawEnd = r.next_end_date.trim();
    const lastHeld = r.last_held_date.trim();

    const startParsed = parseDateString(rawStart);
    const endParsed = parseDateString(rawEnd);

    let status: CalendarEvent["status"] = "unknown";
    if (startParsed.date && !startParsed.isApproximate) {
      status = "scheduled";
    } else if (rawStart || startParsed.isApproximate) {
      status = "approximate";
    } else if (lastHeld) {
      status = "past_only";
    }

    const pref = detectPrefecture(r.next_venue, r.search_name, r.query);

    // Dedup key
    const key = `${r.bar_name}__${startParsed.date || rawStart}__${r.search_name}`;

    if (!eventMap.has(key)) {
      counter++;
      const id = `ev-${counter}-${Buffer.from(r.bar_name).toString("hex").substring(0, 8)}`;
      eventMap.set(key, {
        id,
        barName: r.bar_name,
        searchName: r.search_name,
        query: r.query,
        startDate: startParsed.date,
        endDate: endParsed.date || startParsed.date,
        startTime: startParsed.time,
        endTime: endParsed.time,
        rawStartDate: rawStart,
        rawEndDate: rawEnd,
        isApproximate: startParsed.isApproximate || !startParsed.date,
        status,
        venue: r.next_venue,
        officialUrl: r.official_url,
        sns: r.sns,
        lastHeldDate: lastHeld,
        lat: r.lat ? parseFloat(r.lat) : null,
        lng: r.lng ? parseFloat(r.lng) : null,
        prefecture: pref,
      });
    } else {
      // Merge extra details if available
      const existing = eventMap.get(key)!;
      if (!existing.officialUrl && r.official_url) existing.officialUrl = r.official_url;
      if (!existing.sns && r.sns) existing.sns = r.sns;
      if (!existing.venue && r.next_venue) existing.venue = r.next_venue;
    }
  }

  const allEvents = Array.from(eventMap.values());

  // Sort scheduled events by start date ascending
  allEvents.sort((a, b) => {
    if (a.startDate && b.startDate) {
      return a.startDate.localeCompare(b.startDate);
    }
    if (a.startDate) return -1;
    if (b.startDate) return 1;
    return a.barName.localeCompare(b.barName);
  });

  const scheduledCount = allEvents.filter((e) => e.status === "scheduled").length;
  const approxCount = allEvents.filter((e) => e.status === "approximate").length;
  const pastCount = allEvents.filter((e) => e.status === "past_only").length;

  console.log(`Unique events processed: ${allEvents.length}`);
  console.log(`- Scheduled with exact dates: ${scheduledCount}`);
  console.log(`- Approximate / seasonal dates: ${approxCount}`);
  console.log(`- Past held date only: ${pastCount}`);

  // Ensure public and data directories exist
  const publicDir = path.join(rootDir, "public");
  const dataDir = path.join(rootDir, "data");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // 1. Output JSON for Web UI
  const jsonOutput = {
    updatedAt: new Date().toISOString(),
    stats: {
      total: allEvents.length,
      scheduled: scheduledCount,
      approximate: approxCount,
      past: pastCount,
    },
    events: allEvents,
  };

  const jsonPath = path.join(dataDir, "calendar-events.json");
  const publicJsonPath = path.join(publicDir, "calendar-events.json");
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), "utf-8");
  fs.writeFileSync(publicJsonPath, JSON.stringify(jsonOutput, null, 2), "utf-8");
  console.log(`Saved JSON: ${jsonPath} & ${publicJsonPath}`);

  // 2. Output iCalendar (.ics)
  const icsContent = generateICalendar(allEvents);
  const icsPath = path.join(dataDir, "machibar-events.ics");
  const publicIcsPath = path.join(publicDir, "machibar-events.ics");
  fs.writeFileSync(icsPath, icsContent, "utf-8");
  fs.writeFileSync(publicIcsPath, icsContent, "utf-8");
  console.log(`Saved iCalendar: ${icsPath} & ${publicIcsPath}`);

  console.log("Calendar generation completed successfully!");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Execution failed:", err);
    process.exit(1);
  });
}
