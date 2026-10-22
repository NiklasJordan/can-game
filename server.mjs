// Where and When — static quiz + leaderboard API backed by SQLite.
// No dependencies: Node 22's built-in HTTP server and node:sqlite.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || "/data/scores.db";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";      // enables DELETE /api/scores/:id
const MAX_SCORE = 8000;                                  // 8 rounds × 1000
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

// ------------------------------------------------------------------ database
mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS scores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    score      INTEGER NOT NULL CHECK (score BETWEEN 0 AND ${MAX_SCORE}),
    mode       TEXT    NOT NULL CHECK (mode IN ('noob', 'expert')),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS scores_mode_score ON scores (mode, score DESC, id);
`);
const qTop = db.prepare("SELECT id, name, score, mode, created_at FROM scores WHERE mode = ? ORDER BY score DESC, id ASC LIMIT ?");
const qInsert = db.prepare("INSERT INTO scores (name, score, mode) VALUES (?, ?, ?)");
const qRank = db.prepare("SELECT COUNT(*) AS above FROM scores WHERE mode = ? AND (score > ? OR (score = ? AND id < ?))");
const qDelete = db.prepare("DELETE FROM scores WHERE id = ?");

// ------------------------------------------------------------------ helpers
const send = (res, code, body, headers = {}) => {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(data);
};
const cleanName = (s) => String(s ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);

function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("Body too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(Object.assign(new Error("Invalid JSON"), { code: 400 })); } });
    req.on("error", reject);
  });
}

// simple per-IP limit on new scores (default 60 per 10 minutes; venues often share one address)
const RATE_LIMIT = Math.max(1, Number(process.env.RATE_LIMIT || 60));
const hits = new Map();
function allowPost(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  if (arr.length >= RATE_LIMIT) { hits.set(ip, arr); return false; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < win)) hits.delete(k);
  return true;
}
const clientIp = (req) => (process.env.TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden");
  try {
    const st = await stat(file);
    if (!st.isFile()) return send(res, 404, "Not found");
    const body = await readFile(file);
    const ext = path.extname(file);
    send(res, 200, body, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
  } catch { send(res, 404, "Not found"); }
}

// ------------------------------------------------------------------ routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });

    if (url.pathname === "/api/scores" && req.method === "GET") {
      const mode = url.searchParams.get("mode") === "expert" ? "expert" : "noob";
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 10));
      return send(res, 200, { mode, scores: qTop.all(mode, limit) }, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/api/scores" && req.method === "POST") {
      if (!allowPost(clientIp(req))) return send(res, 429, { error: "Too many scores from this address. Try again in a few minutes." });
      const b = await readJson(req);
      const name = cleanName(b.name);
      const score = Number(b.score);
      const mode = b.mode;
      if (!name) return send(res, 400, { error: "Type a name to save your score." });
      if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE || score % 500 !== 0) return send(res, 400, { error: "That score is not possible in this quiz." });
      if (mode !== "noob" && mode !== "expert") return send(res, 400, { error: "Unknown mode." });
      const { lastInsertRowid } = qInsert.run(name, score, mode);
      const id = Number(lastInsertRowid);
      const rank = qRank.get(mode, score, score, id).above + 1;
      return send(res, 201, { id, rank });
    }

    const del = url.pathname.match(/^\/api\/scores\/(\d+)$/);
    if (del && req.method === "DELETE") {
      if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return send(res, 401, { error: "Not allowed." });
      const { changes } = qDelete.run(Number(del[1]));
      return send(res, changes ? 200 : 404, { deleted: changes });
    }

    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found." });
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    const code = e.code === 413 || e.code === 400 ? e.code : 500;
    if (code === 500) console.error(e);
    send(res, code, { error: code === 500 ? "Server error." : e.message });
  }
});

server.listen(PORT, () => console.log(`Where and When on :${PORT}, database ${DB_PATH}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
