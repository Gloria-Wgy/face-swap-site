export const config = { runtime: "nodejs" };

import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

// Upstash（未配置则为 null，自动跳过限次，方便联调）
const redisClient =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

// CORS：支持从环境变量配置多个来源，逗号分隔
const ORIGINS =
  (process.env.FRONTEND_ORIGIN || "https://face-swap-site.vercel.app")
    .split(",")
    .map(s => s.trim());

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
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

  // token: 支持 query 或 Authorization 头
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const token = bearer || (req.query ? req.query.token : null);
  if (!token) {
    return res.status(400).json({ ok: false, error: "Missing token" });
  }

  try {
    const { email } = jwt.verify(token, process.env.JWT_SECRET);
    const key = "free_used:" + crypto.createHash("sha256").update(email).digest("hex");

    if (!redisClient) {
      return res.status(200).json({
        ok: true,
        email,
        used: false,
        note: "no upstash configured, skipping limit"
      });
    }

    const used = await redisClient.get<string | null>(key);
    return res.status(200).json({ ok: true, email, used: used === "1" });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid or expired token" });
  }
}
