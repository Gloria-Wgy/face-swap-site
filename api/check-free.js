export const config = { runtime: "nodejs" };

import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

// ====== Upstash REST 客户端（未配置则为 null，自动跳过限次）======
const redisClient =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

// 允许的前端域名（和其他 API 一致）
const ALLOWED_ORIGINS = ["https://chatgpt-web-demo-alpha.vercel.app"];

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

export default async function handler(req, res) {
  if (setCors(req, res)) return;

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Only GET allowed" });
  }

  const { token } = req.query || {};
  if (!token) {
    return res.status(400).json({ ok: false, error: "Missing token" });
  }

  try {
    const { email } = jwt.verify(token, process.env.JWT_SECRET);
    const key = "free_used:" + crypto.createHash("sha256").update(email).digest("hex");

    // 未配置 Upstash 时，默认认为“未使用过”，方便先联调
    if (!redisClient) {
      return res.status(200).json({ ok: true, email, used: false, note: "no upstash, skipping limit" });
    }

    const used = await redisClient.get(key); // string | null
    return res.status(200).json({ ok: true, email, used: used === "1" });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid or expired token" });
  }
}
