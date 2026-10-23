const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { SECRET } = require("./config");

const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const VIDEO_EXT = [".mp4", ".webm", ".ogg", ".mov", ".m4v"];
// File types that can run code are not accepted
const BLOCKED_EXT = [
  ".html", ".htm", ".svg", ".js", ".mjs", ".exe", ".bat", ".cmd", ".com",
  ".ps1", ".sh", ".msi", ".php", ".jar", ".vbs", ".scr", ".dll",
];

// Pages allowed to call this API (add your real website address here when you deploy)
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5500,http://127.0.0.1:5500"
)
  .split(",")
  .map((s) => s.trim());

// ---------- simple rate limiting (kept in memory) ----------
const failures = new Map(); // key -> { count, resetAt }

function isBlocked(key, max) {
  const e = failures.get(key);
  return !!e && e.resetAt > Date.now() && e.count >= max;
}

function addHit(key, windowMs) {
  const now = Date.now();
  let e = failures.get(key);
  if (!e || e.resetAt <= now) {
    e = { count: 0, resetAt: now + windowMs };
    failures.set(key, e);
  }
  e.count++;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of failures) if (e.resetAt <= now) failures.delete(k);
}, 60 * 1000).unref();

function userFromToken(token) {
  try {
    return jwt.verify(token || "", SECRET);
  } catch {
    return null;
  }
}

const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(
  cors({
    origin(origin, cb) {
      cb(null, !origin || ALLOWED_ORIGINS.includes(origin));
    },
  })
);
app.use(express.json({ limit: "10kb" }));

// Serve only the chat page (not your whole folder)
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/register", (req, res) => {
  const { username, password } = req.body || {};

  const regKey = "reg:" + req.ip;
  if (isBlocked(regKey, 10)) {
    return res.status(429).json({ error: "Too many sign-ups. Try again later." });
  }
  addHit(regKey, 60 * 60 * 1000);

  if (typeof username !== "string" || !/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3-20 letters, numbers or underscores" });
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: "Password must be 8 to 72 characters" });
  }
  if (db.prepare("SELECT 1 AS ok FROM users WHERE lower(username) = lower(?)").get(username)) {
    return res.status(400).json({ error: "Username already taken" });
  }

  const hash = bcrypt.hashSync(password, 12);
  try {
    const result = db
      .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run(username, hash);
    res.json({ message: "Account created", id: Number(result.lastInsertRowid) });
  } catch (e) {
    res.status(400).json({ error: "Username already taken" });
  }
});

app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const userKey = "login:" + req.ip + ":" + username.toLowerCase();
  const ipKey = "loginip:" + req.ip;
  const WINDOW = 15 * 60 * 1000;
  if (isBlocked(userKey, 5) || isBlocked(ipKey, 30)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    addHit(userKey, WINDOW);
    addHit(ipKey, WINDOW);
    return res.status(401).json({ error: "Wrong username or password" });
  }

  failures.delete(userKey);
  const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: "7d" });
  res.json({ token, username: user.username });
});

// Upload a file (raw bytes in the request body, max 20 MB, login required)
app.post("/upload", express.raw({ type: "*/*", limit: "20mb" }), (req, res) => {
  const header = req.headers.authorization || "";
  const user = userFromToken(header.replace("Bearer ", ""));
  if (!user) return res.status(401).json({ error: "Not logged in" });

  const upKey = "up:" + user.id;
  if (isBlocked(upKey, 30)) {
    return res.status(429).json({ error: "Too many uploads. Try again in a few minutes." });
  }

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: "Empty file" });
  }

  const original = path.basename(String(req.query.name || "file")).slice(0, 100);
  const ext = path.extname(original).toLowerCase().replace(/[^.a-z0-9]/g, "");
  if (BLOCKED_EXT.includes(ext)) {
    return res.status(400).json({ error: "This file type is not allowed" });
  }

  addHit(upKey, 10 * 60 * 1000);
  const stored = crypto.randomBytes(16).toString("hex") + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), req.body);

  res.json({
    url: "/uploads/" + stored,
    name: original,
    isImage: IMAGE_EXT.includes(ext),
    isVideo: VIDEO_EXT.includes(ext),
  });
});

// Download a file. Only people who are part of the chat it was sent in can open it.
app.get("/uploads/:name", (req, res) => {
  const user = userFromToken(req.query.token);
  if (!user) return res.status(401).send("Not logged in");

  const name = req.params.name;
  if (!/^[a-f0-9]{32}(\.[a-z0-9]+)?$/.test(name)) return res.status(404).send("Not found");

  const url = "/uploads/" + name;
  const allowed =
    db
      .prepare(
        "SELECT 1 AS ok FROM messages WHERE file_url = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1"
      )
      .get(url, user.id, user.id) ||
    db
      .prepare(
        `SELECT 1 AS ok FROM chat_group_messages gm
         JOIN chat_group_members m ON m.group_id = gm.group_id
         WHERE gm.file_url = ? AND m.user_id = ? LIMIT 1`
      )
      .get(url, user.id);
  if (!allowed) return res.status(404).send("Not found");

  const ext = path.extname(name).toLowerCase();
  const inline = IMAGE_EXT.includes(ext) || VIDEO_EXT.includes(ext);
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (!inline) res.setHeader("Content-Disposition", "attachment");

  res.sendFile(path.join(UPLOAD_DIR, name), (err) => {
    if (err && !res.headersSent) res.status(404).send("Not found");
  });
});

app.use((err, req, res, next) => {
  const tooBig = err.status === 413 || err.type === "entity.too.large";
  res
    .status(tooBig ? 413 : 500)
    .json({ error: tooBig ? "File too large (max 20 MB)" : "Server error" });
});

app.listen(3000, () => console.log("API running on http://localhost:3000"));
