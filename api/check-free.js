// file: api/check-free.js  （CommonJS 版本）
exports.config = { runtime: "nodejs" };

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

// 允许的前端域名
const ALLOWED_ORIGINS = ["https://face-swap-site.vercel.app"];

// Upstash 客户端（没配也能跑，直接视为未限制）
const redisClient =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
    : null;

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = async function handler(req, res) {
  if (setCors(req, res)) return;

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Only GET allowed" });
  }

  const { token } = req.query || {};
  if (!token) return res.status(400).json({ ok: false, error: "Missing token" });

  try {
    const { email } = jwt.verify(token, process.env.JWT_SECRET);
    const key = "free_count:" + crypto.createHash("sha256").update(email).digest("hex");

    if (!redisClient) {
      // 未接 Upstash，默认未用，方便先联调
      return res.status(200).json({ ok: true, email, used: 0, remaining: 10, note: "no upstash" });
    }

    const current = await redisClient.get(key);
    const used = parseInt(current || "0", 10);
    const remaining = Math.max(0, 10 - used);
    return res.status(200).json({ ok: true, email, used, remaining });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid or expired token" });
  }
};
