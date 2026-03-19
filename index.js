require("dotenv").config();
const http = require("http");
const WebSocket = require("ws");
const Redis = require("redis");

const redis = Redis.createClient({
  url: process.env.REDIS_URL,
});

let ws;
let subscribedTokens = new Set();

async function getRedisTokens() {
  return await redis.sMembers("market:subscriptions");
}

function parseFullPacket(packet, packetLength) {
  const token = packet.readInt32BE(0);
  const ltp = packet.readInt32BE(4) / 100;

  let payload = {
    token,
    ltp,
    ts: Date.now(),
  };

  if (packetLength >= 44) {
    payload.open = packet.readInt32BE(28) / 100;
    payload.high = packet.readInt32BE(32) / 100;
    payload.low = packet.readInt32BE(36) / 100;
    payload.close = packet.readInt32BE(40) / 100;
  }

  return payload;
}

async function subscribeNewTokens() {
  try {
    const tokens = await getRedisTokens();
    const numericTokens = tokens.map(Number);
    const newTokens = numericTokens.filter(t => !subscribedTokens.has(t));

    if (!newTokens.length) return;

    console.log("Subscribing:", newTokens.length);

    ws.send(JSON.stringify({ a: "subscribe", v: newTokens }));
    ws.send(JSON.stringify({ a: "mode", v: ["full", newTokens] }));

    newTokens.forEach(t => subscribedTokens.add(t));
  } catch (err) {
    console.error("Subscription error:", err.message);
  }
}

async function startWorker() {
  try {
    await redis.connect();
    console.log("✅ Connected to Redis");

    const wsUrl = `wss://ws.kite.trade?api_key=${process.env.KITE_API_KEY}&access_token=${process.env.KITE_ACCESS_TOKEN}`;
    ws = new WebSocket(wsUrl);

    ws.on("open", async () => {
      console.log("✅ Connected to Kite");

      await subscribeNewTokens();
      setInterval(subscribeNewTokens, 5000);
    });

    ws.on("message", async (data) => {
      if (!Buffer.isBuffer(data)) return;

      try {
        let offset = 0;
        const packetCount = data.readUInt16BE(offset);
        offset += 2;

        for (let i = 0; i < packetCount; i++) {
          const packetLength = data.readUInt16BE(offset);
          offset += 2;

          const packet = data.slice(offset, offset + packetLength);
          offset += packetLength;

          const payload = parseFullPacket(packet, packetLength);

          await redis.publish("market:ticks", JSON.stringify(payload));
          await redis.hSet(
            "market:latest",
            payload.token.toString(),
            JSON.stringify(payload)
          );
        }
      } catch (err) {
        console.error("Packet parse error:", err.message);
      }
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
    });

    ws.on("close", () => {
      console.log("⚠️ WebSocket closed. Reconnecting in 5s...");
      setTimeout(startWorker, 5000);
    });

  } catch (err) {
    console.error("Startup error:", err.message);
    setTimeout(startWorker, 5000); // retry
  }
}

//
// ✅ REQUIRED FOR HOSTINGER (HTTP SERVER)
//
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Market streamer is running\n");
});

server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await startWorker();
});