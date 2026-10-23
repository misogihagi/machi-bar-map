import path from "node:path";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PUBLIC_DIR = path.join(import.meta.dir, "public");

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Route: Root / Index
    if (pathname === "/" || pathname === "/index.html") {
      const filePath = path.join(PUBLIC_DIR, "index.html");
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    // Route: iCalendar (.ics) download
    if (pathname === "/machibar-events.ics") {
      const filePath = path.join(PUBLIC_DIR, "machibar-events.ics");
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'attachment; filename="machibar-events.ics"',
          },
        });
      }
    }

    // Route: Calendar Events JSON
    if (pathname === "/calendar-events.json" || pathname === "/api/events") {
      const filePath = path.join(PUBLIC_DIR, "calendar-events.json");
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    // Fallback: Check if file exists in public directory
    const fallbackPath = path.join(PUBLIC_DIR, pathname);
    const fallbackFile = Bun.file(fallbackPath);
    if (await fallbackFile.exists()) {
      return new Response(fallbackFile);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🍺 街バル開催カレンダー サーバーが起動しました: http://localhost:${server.port}`);