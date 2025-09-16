export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

// ========= Upstash REST 客户端（未配置则为 null，自动跳过限次） =========
const redisClient =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

// 允许跨域的前端域名
const ALLOWED_ORIGINS = ["https://chatgpt-web-demo-alpha.vercel.app"];

// 与 /scenes 文件名完全一致（区分大小写）
const SCENES = [
  "Actor.png",
  "Artist.png",
  "Astronaut.png",
  "Athlete.png",
  "Doctor.png",
  "Firefighter.png",
  "Lawyer.png",
  "Musician.png",
  "Policeman.png",
  "Scientist.png"
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

// 兼容 formidable 返回的数组/单个文件
const pickFile = (f) => (Array.isArray(f) ? f[0] : f) || null;

// 读取部署包内静态文件（scenes）
const readLocal = (...segs) => {
  const p = path.join(process.cwd(), ...segs);
  return fs.existsSync(p) ? fs.createReadStream(p) : null;
};

export default async function handler(req, res) {
  if (setCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });

  // 1) 校验 token（JWT）
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: "No token" });

  let email;
  try {
    ({ email } = jwt.verify(token, process.env.JWT_SECRET));
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  // 2) 免费一次校验（未配置 Upstash 时跳过限次，便于先联调）
  const key = "free_used:" + crypto.createHash("sha256").update(email).digest("hex");
  try {
    if (redisClient) {
      const used = await redisClient.get(key); // string | null
      if (used === "1") {
        return res.status(403).json({ error: "Free chance already used" });
      }
    }
  } catch (e) {
    console.warn("Upstash get failed, skipping limit:", e?.message);
  }

  // 3) 解析上传表单（限制大小/类型更安全）
  const form = formidable({
    multiples: true,
    keepExtensions: true,
    uploadDir: "/tmp",
    maxFileSize: 5 * 1024 * 1024, // 5MB/张
    filter: ({ mimetype }) => /image\/(jpeg|png|webp)/.test(mimetype || "")
  });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ error: "File upload error" });

    const src = pickFile(files.source);
    const tgt = pickFile(files.target);
    if (!src || !tgt) return res.status(400).json({ error: "Need two photos" });

    const results = [];
    let echoB64 = "";
    try {
      echoB64 = fs.readFileSync(src.filepath).toString("base64");
    } catch {
      return res.status(500).json({ error: "Temp file not found" });
    }

    // 4) 调用 OpenAI（无 KEY 或 USE_ECHO=1 则回显）
    const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

    for (const sceneName of SCENES) {
      const sceneStream = readLocal("scenes", sceneName);
      if (!sceneStream) {
        results.push({ scene: sceneName, b64: echoB64, note: "scene missing" });
        continue;
      }

      if (!client || process.env.USE_ECHO === "1") {
        results.push({ scene: sceneName, b64: echoB64, note: "echo" });
        continue;
      }

      try {
        // 注：若你当前 openai SDK 不支持 image 数组，需改为 images.edits 版本。
        const r = await client.images.generate({
          model: "gpt-image-1",
          prompt:
            "Replace the main person's face in the scene with the person from the two reference photos. Natural blend, keep pose/body/lighting.",
          image: [sceneStream, fs.createReadStream(src.filepath), fs.createReadStream(tgt.filepath)],
          size: "768x768",
          response_format: "b64_json"
        });

        const b64 = r?.data?.[0]?.b64_json || echoB64;
        results.push({ scene: sceneName, b64 });
      } catch (e) {
        console.error("openai fail", sceneName, e?.message);
        results.push({ scene: sceneName, b64: echoB64, note: "fallback" });
      }
    }

    // 5) 写入“已用一次免费”（配置了 Upstash 才会写入）
    try {
      if (redisClient) {
        await redisClient.set(key, "1", { ex: 60 * 60 * 24 * 365 }); // 1年
      }
    } catch (e) {
      console.warn("Upstash set failed:", e?.message);
    }

    // 6) 清理临时文件（隐私）
    try { fs.unlinkSync(src.filepath); } catch {}
    try { fs.unlinkSync(tgt.filepath); } catch {}

    return res.status(200).json({ images: results, email });
  });
}
