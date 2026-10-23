const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const db = require("./db");
const { SECRET } = require("./config");

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_RE = /\.(mp4|webm|ogg|mov|m4v)$/i;

const MAX_TEXT = 4000; // longest allowed message
const MAX_MESSAGES_PER_10S = 30; // per connection
const MAX_CONNECTIONS_PER_USER = 10;

const wss = new WebSocketServer({ port: 8080, maxPayload: 64 * 1024 });
const online = new Map(); // userId -> set of open sockets

function isOnline(userId) {
  const s = online.get(userId);
  return !!s && s.size > 0;
}

function sendTo(userId, payload) {
  const sockets = online.get(userId);
  if (!sockets) return;
  for (const s of sockets) {
    if (s.readyState === 1) s.send(JSON.stringify(payload));
  }
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function sendUsers(socket, userId) {
  const users = db
    .prepare("SELECT id, username FROM users WHERE id != ? ORDER BY username")
    .all(userId)
    .map((u) => ({ username: u.username, online: isOnline(u.id) }));
  socket.send(JSON.stringify({ type: "users", users }));
}

// ---------- file helpers ----------
function parseFile(f) {
  if (
    f &&
    typeof f.url === "string" &&
    /^\/uploads\/[a-f0-9]{32}(\.[a-z0-9]+)?$/.test(f.url)
  ) {
    return {
      url: f.url,
      name: String(f.name || "file").slice(0, 100),
      isImage: IMAGE_RE.test(f.url),
      isVideo: VIDEO_RE.test(f.url),
    };
  }
  return null;
}

function fileFromRow(url, name) {
  if (!url) return null;
  return { url, name, isImage: IMAGE_RE.test(url), isVideo: VIDEO_RE.test(url) };
}

// ---------- group helpers ----------
function membersOf(gid) {
  return db
    .prepare(
      "SELECT u.id, u.username FROM chat_group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?"
    )
    .all(gid);
}

function groupInfo(gid) {
  const g = db.prepare("SELECT id, name, creator_id FROM chat_groups WHERE id = ?").get(gid);
  if (!g) return null;
  const creator = db.prepare("SELECT username FROM users WHERE id = ?").get(g.creator_id);
  return {
    id: g.id,
    name: g.name,
    creator: creator ? creator.username : null,
    members: membersOf(gid).map((m) => m.username),
  };
}

function groupsFor(userId) {
  return db
    .prepare("SELECT group_id FROM chat_group_members WHERE user_id = ? ORDER BY group_id")
    .all(userId)
    .map((r) => groupInfo(r.group_id))
    .filter(Boolean);
}

function isMember(gid, userId) {
  return !!db
    .prepare("SELECT 1 AS ok FROM chat_group_members WHERE group_id = ? AND user_id = ?")
    .get(gid, userId);
}

wss.on("connection", (socket, req) => {
  const token = new URL(req.url, "http://localhost").searchParams.get("token");
  let user;
  try {
    user = jwt.verify(token, SECRET);
  } catch {
    socket.close(1008, "Invalid token");
    return;
  }

  if ((online.get(user.id) || new Set()).size >= MAX_CONNECTIONS_PER_USER) {
    socket.close(1013, "Too many connections");
    return;
  }

  const wasOffline = !isOnline(user.id);
  if (!online.has(user.id)) online.set(user.id, new Set());
  online.get(user.id).add(socket);
  console.log(user.username, "connected");
  if (wasOffline) broadcast({ type: "presence", username: user.username, online: true });

  // Slow down anyone sending too many messages
  const recent = [];
  function tooFast() {
    const now = Date.now();
    while (recent.length && recent[0] < now - 10000) recent.shift();
    if (recent.length >= MAX_MESSAGES_PER_10S) return true;
    recent.push(now);
    return false;
  }

  function sendError(text) {
    socket.send(JSON.stringify({ type: "error", error: text }));
  }

  sendUsers(socket, user.id);

  // Private chat history
  const rows = db.prepare(`
    SELECT m.id, m.text, m.created_at, (m.read_at IS NOT NULL) AS "read",
           m.file_url, m.file_name,
           s.username AS "from", r.username AS "to"
    FROM messages m
    JOIN users s ON s.id = m.sender_id
    JOIN users r ON r.id = m.receiver_id
    WHERE m.sender_id = ? OR m.receiver_id = ?
    ORDER BY m.id DESC LIMIT 200
  `).all(user.id, user.id).reverse();

  const history = rows.map((r) => ({
    id: r.id,
    text: r.text,
    created_at: r.created_at,
    read: !!r.read,
    from: r.from,
    to: r.to,
    file: fileFromRow(r.file_url, r.file_name),
  }));
  socket.send(JSON.stringify({ type: "history", messages: history }));

  // Groups and group history
  socket.send(JSON.stringify({ type: "groups", groups: groupsFor(user.id) }));

  const groupRows = db.prepare(`
    SELECT gm.id, gm.group_id AS gid, gm.text, gm.created_at, gm.file_url, gm.file_name,
           s.username AS "from"
    FROM chat_group_messages gm
    JOIN users s ON s.id = gm.sender_id
    WHERE gm.group_id IN (SELECT group_id FROM chat_group_members WHERE user_id = ?)
    ORDER BY gm.id DESC LIMIT 500
  `).all(user.id).reverse();

  const groupHistory = groupRows.map((r) => ({
    id: r.id,
    group: r.gid,
    from: r.from,
    text: r.text,
    created_at: r.created_at,
    file: fileFromRow(r.file_url, r.file_name),
  }));
  socket.send(JSON.stringify({ type: "group_history", messages: groupHistory }));

  socket.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    // Refresh the contacts list
    if (msg.type === "users") {
      sendUsers(socket, user.id);
      return;
    }

    // "ali is typing..." (private)
    if (msg.type === "typing") {
      const target = db.prepare("SELECT id FROM users WHERE username = ?").get(String(msg.to || ""));
      if (target) sendTo(target.id, { type: "typing", from: user.username });
      return;
    }

    // "ali is typing..." (group)
    if (msg.type === "group_typing") {
      const gid = Number(msg.group);
      if (!isMember(gid, user.id)) return;
      for (const m of membersOf(gid)) {
        if (m.id !== user.id) {
          sendTo(m.id, { type: "group_typing", group: gid, from: user.username });
        }
      }
      return;
    }

    // Reader opened a private chat: mark messages from msg.from as read
    if (msg.type === "read") {
      const sender = db.prepare("SELECT id FROM users WHERE username = ?").get(String(msg.from || ""));
      if (!sender) return;
      const result = db.prepare(
        "UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL"
      ).run(sender.id, user.id);
      if (result.changes > 0) sendTo(sender.id, { type: "read", by: user.username });
      return;
    }

    // Everything below creates data, so it is rate limited
    if (tooFast()) {
      sendError("You are sending too fast. Please slow down.");
      return;
    }

    // Create a new group
    if (msg.type === "create_group") {
      const name = String(msg.name || "").trim().slice(0, 50);
      const names = Array.isArray(msg.members) ? [...new Set(msg.members.map(String))] : [];
      const memberRows = names
        .slice(0, 50)
        .map((n) => db.prepare("SELECT id FROM users WHERE username = ?").get(n))
        .filter(Boolean)
        .filter((u) => u.id !== user.id);

      if (!name || memberRows.length === 0) {
        sendError("A group needs a name and at least one other member");
        return;
      }

      const res = db.prepare("INSERT INTO chat_groups (name, creator_id) VALUES (?, ?)").run(name, user.id);
      const gid = Number(res.lastInsertRowid);
      const add = db.prepare("INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)");
      add.run(gid, user.id);
      memberRows.forEach((u) => add.run(gid, u.id));

      const info = groupInfo(gid);
      for (const m of membersOf(gid)) sendTo(m.id, { type: "group", group: info });
      return;
    }

    // Group message (text, file, or both)
    if (msg.group !== undefined && msg.group !== null) {
      const gid = Number(msg.group);
      if (!isMember(gid, user.id)) {
        sendError("You are not a member of this group");
        return;
      }

      const text = String(msg.text || "").trim();
      const file = parseFile(msg.file);
      if (!text && !file) {
        sendError("Empty message");
        return;
      }
      if (text.length > MAX_TEXT) {
        sendError("Message too long (max " + MAX_TEXT + " characters)");
        return;
      }

      const result = db.prepare(
        "INSERT INTO chat_group_messages (group_id, sender_id, text, file_url, file_name) VALUES (?, ?, ?, ?, ?)"
      ).run(gid, user.id, text, file ? file.url : null, file ? file.name : null);
      const id = Number(result.lastInsertRowid);
      const row = db.prepare("SELECT created_at FROM chat_group_messages WHERE id = ?").get(id);

      const payload = {
        type: "group_message",
        id,
        group: gid,
        from: user.username,
        text,
        file,
        created_at: row.created_at,
      };
      for (const m of membersOf(gid)) sendTo(m.id, payload);
      return;
    }

    // Normal private message (text, file, or both)
    const text = String(msg.text || "").trim();
    const file = parseFile(msg.file);

    const receiver = db.prepare("SELECT id, username FROM users WHERE username = ?").get(String(msg.to || ""));
    if (!receiver || (!text && !file)) {
      sendError("User not found or empty message");
      return;
    }
    if (text.length > MAX_TEXT) {
      sendError("Message too long (max " + MAX_TEXT + " characters)");
      return;
    }

    const result = db.prepare(
      "INSERT INTO messages (sender_id, receiver_id, text, file_url, file_name, file_image) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      user.id,
      receiver.id,
      text,
      file ? file.url : null,
      file ? file.name : null,
      file && file.isImage ? 1 : 0
    );
    const id = Number(result.lastInsertRowid);
    const row = db.prepare("SELECT created_at FROM messages WHERE id = ?").get(id);

    const payload = {
      type: "message",
      id,
      from: user.username,
      to: receiver.username,
      text,
      file,
      created_at: row.created_at,
      read: false,
    };
    sendTo(receiver.id, payload);
    if (receiver.id !== user.id) sendTo(user.id, payload);
  });

  socket.on("close", () => {
    online.get(user.id).delete(socket);
    console.log(user.username, "disconnected");
    if (!isOnline(user.id)) broadcast({ type: "presence", username: user.username, online: false });
  });
});

console.log("Chat server running on ws://localhost:8080");
