import express from "express";
import path from "path";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import cors from "cors";

// ---------- LOWDB (JSON DATABASE) ----------
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

const adapter = new JSONFile("weather.json");
const db = new Low(adapter, { readings: [] });

await db.read();
db.data ||= { readings: [] };

// ---------- EXPRESS SETUP ----------
const app = express();
app.use(express.json());
app.use(cors());

// Serve static frontend (optional)
app.use(express.static(path.join(process.cwd(), "public")));

// ---------- DISCORD WEBHOOK ----------
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

// High temp alert
async function sendDiscordNotification(temp, hum) {
  if (!DISCORD_WEBHOOK_URL) return;
  if (temp <= 30) return;

  const payload = {
    content: `🔥 **HIGH TEMPERATURE ALERT!**
🌡️ Temp: **${temp.toFixed(1)}°C**
💧 Humidity: **${hum.toFixed(1)}%**`
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, payload);
  } catch (err) {
    console.error("Discord error:", err.message);
  }
}

// ----------- WEBSOCKET SETUP -----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastJSON(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  console.log("WebSocket client connected");

  if (db.data.readings.length > 0) {
    const latest = db.data.readings[db.data.readings.length - 1];
    ws.send(JSON.stringify({ type: "latest-reading", data: latest }));
  }

  ws.on("close", () => console.log("WebSocket disconnected"));
});

// ----------- POST /api/readings -----------
app.post("/api/readings", async (req, res) => {
  const { temperature, humidity } = req.body;

  if (typeof temperature !== "number" || typeof humidity !== "number") {
    return res.status(400).json({ error: "temperature and humidity must be numbers" });
  }

  const created_at = new Date().toISOString();

  const reading = {
    id: db.data.readings.length + 1,
    temperature,
    humidity,
    created_at,
  };

  db.data.readings.push(reading);
  await db.write();

  broadcastJSON({ type: "new-reading", data: reading });
  sendDiscordNotification(temperature, humidity);

  res.status(201).json(reading);
});

// ----------- GET /api/readings -----------
app.get("/api/readings", (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const rows = db.data.readings.slice(-limit).reverse();
  res.json(rows);
});

// ----------- GET /api/readings/latest -----------
app.get("/api/readings/latest", (req, res) => {
  if (db.data.readings.length === 0) {
    return res.status(404).json({ error: "No data yet" });
  }

  const latest = db.data.readings[db.data.readings.length - 1];
  res.json(latest);
});

// ----------- START SERVER -----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
