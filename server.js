const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');  // NEW: works on Render
const axios = require('axios');
const cors = require('cors');

// Load Discord webhook URL from Render environment variable
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

const app = express();
app.use(express.json());
app.use(cors());

// Serve frontend files from "public" folder (optional)
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------
// SQLite Setup (better-sqlite3 version)
// ---------------------------------------
const db = new Database('weather.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    temperature REAL NOT NULL,
    humidity REAL NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// ---------------------------------------
// HTTP + WebSocket setup
// ---------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Broadcast message to all WebSocket clients
function broadcastJSON(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ---------------------------------------
// Discord Alert
// ---------------------------------------
async function sendDiscordNotification(temp, hum) {
  if (!DISCORD_WEBHOOK_URL) return;
  if (temp <= 30) return;

  const payload = {
    content: `🔥 **HIGH TEMPERATURE ALERT!**
🌡️ Temperature: **${temp.toFixed(1)}°C**
💧 Humidity: **${hum.toFixed(1)}%**`
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, payload);
  } catch (err) {
    console.error("Discord webhook error:", err.message);
  }
}

// ---------------------------------------
// POST /api/readings  (from ESP32 or Wokwi)
// ---------------------------------------
app.post('/api/readings', (req, res) => {
  const { temperature, humidity } = req.body;

  if (typeof temperature !== 'number' || typeof humidity !== 'number') {
    return res.status(400).json({ error: 'temperature and humidity must be numbers' });
  }

  const createdAt = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO readings (temperature, humidity, created_at)
    VALUES (?, ?, ?)
  `);

  const result = insert.run(temperature, humidity, createdAt);

  const reading = {
    id: result.lastInsertRowid,
    temperature,
    humidity,
    created_at: createdAt
  };

  broadcastJSON({ type: "new-reading", data: reading });

  sendDiscordNotification(temperature, humidity);

  res.status(201).json(reading);
});

// ---------------------------------------
// GET /api/readings
// ---------------------------------------
app.get('/api/readings', (req, res) => {
  const limit = Number(req.query.limit) || 50;

  const rows = db.prepare(`
    SELECT * FROM readings ORDER BY created_at DESC LIMIT ?
  `).all(limit);

  res.json(rows);
});

// ---------------------------------------
// GET /api/readings/latest
// ---------------------------------------
app.get('/api/readings/latest', (req, res) => {
  const row = db.prepare(`
    SELECT * FROM readings ORDER BY created_at DESC LIMIT 1
  `).get();

  if (!row) return res.status(404).json({ error: "No data yet" });
  res.json(row);
});

// ---------------------------------------
// WebSocket Handler
// ---------------------------------------
wss.on('connection', ws => {
  console.log("WebSocket client connected");

  const row = db.prepare(`
    SELECT * FROM readings ORDER BY created_at DESC LIMIT 1
  `).get();

  if (row) {
    ws.send(JSON.stringify({ type: "latest-reading", data: row }));
  }

  ws.on('close', () => console.log("WebSocket disconnected"));
});

// ---------------------------------------
// Start Server
// ---------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
