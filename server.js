const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cors = require('cors');

// Load Discord webhook URL from environment variable (Render)
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

const app = express();
app.use(express.json());
app.use(cors());

// Serve frontend files from "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------
// SQLite Database Setup
// ----------------------
const db = new sqlite3.Database('weather.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      temperature REAL NOT NULL,
      humidity REAL NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
});

// ----------------------
// HTTP + WebSocket setup
// ----------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Broadcast message to all connected websocket clients
function broadcastJSON(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ----------------------
// Discord Alert Function
// ----------------------
async function sendDiscordNotification(temp, hum) {
  if (!DISCORD_WEBHOOK_URL) return;

  if (temp <= 30) return; // Only alert above 30°C

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

// ----------------------
// POST /api/readings  (from Wokwi/Pico)
// ----------------------
app.post('/api/readings', (req, res) => {
  const { temperature, humidity } = req.body;

  if (typeof temperature !== 'number' || typeof humidity !== 'number') {
    return res.status(400).json({ error: 'temperature and humidity must be numbers' });
  }

  const createdAt = new Date().toISOString();

  db.run(
    `INSERT INTO readings (temperature, humidity, created_at)
     VALUES (?, ?, ?)`,
    [temperature, humidity, createdAt],
    function (err) {
      if (err) {
        console.error("DB insert error:", err);
        return res.status(500).json({ error: "DB error" });
      }

      const reading = {
        id: this.lastID,
        temperature,
        humidity,
        created_at: createdAt
      };

      // Notify dashboard
      broadcastJSON({ type: "new-reading", data: reading });

      // Notify Discord
      sendDiscordNotification(temperature, humidity);

      res.status(201).json(reading);
    }
  );
});

// ----------------------
// GET /api/readings
// ----------------------
app.get('/api/readings', (req, res) => {
  const limit = Number(req.query.limit) || 50;

  db.all(
    `SELECT * FROM readings ORDER BY created_at DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    }
  );
});

// ----------------------
// GET /api/readings/latest
// ----------------------
app.get('/api/readings/latest', (req, res) => {
  db.get(
    `SELECT * FROM readings ORDER BY created_at DESC LIMIT 1`,
    [],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(404).json({ error: "No data yet" });
      res.json(row);
    }
  );
});

// WebSocket behavior
wss.on('connection', ws => {
  console.log("WebSocket client connected");

  // Send latest reading immediately
  db.get(
    `SELECT * FROM readings ORDER BY created_at DESC LIMIT 1`,
    [],
    (err, row) => {
      if (!err && row) {
        ws.send(JSON.stringify({ type: "latest-reading", data: row }));
      }
    }
  );

  ws.on('close', () => console.log("WebSocket disconnected"));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
