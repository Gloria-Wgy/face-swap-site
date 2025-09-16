export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

// 新增：用于本地合成“假预览”
let sharp = null;
try {
  sharp = (await import("sharp")).default;
} catch {
  // 没装 sharp 时会自动退回到“只返回场景原图”模式
  console.warn("sharp is not installed; fallback to scene-only previews");
}

// ========= Upstash（未配置则跳过限次） =========
const redisClient =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
    : null;

const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || "https://face-swap-site.vercel.app")
  .split(",").map(s => s.trim());

// 与 /scenes 完全一致（区分大小写）
const SCENES = [
  "Actor.png","Artist.png","Astronaut.png","Athlete.png","Doctor.png",
  "Firefighter.png","Lawyer.png","Musician.png","Policeman.png","Scientist.png"
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}
const pickFile = f => (Array.isArray(f) ? f[0] : f) || null;
const scenePath = name => path.join(process.cwd(), "scenes", name);
const readLocal = name => fs.existsSync(scenePath(name)) ? fs.createReadStream(scenePath(name)) : null;

export default async function handler(req, res) {
  if (setCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });

  // 1) token
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: "No token" });

  let email;
  try { ({ email } = jwt.verify(token, process.env.JWT_SECRET)); }
  catch { return res.status(401).json({ error: "Invalid token" }); }

  // 2) 限一次（有 Upstash 才检查）
  const key = "free_used:" + crypto.createHash("sha256").update(email).digest("hex");
  try {
    if (redisClient) {
      const used = await redisClient.get(key);
      if (used === "1") return res.status(403).json({ error: "Free chance already used" });
    }
  } catch (e) { console.warn("Upstash get failed:", e?.message); }

  // 3) 上传
  const form = formidable({
    multiples: true, keepExtensions: true, uploadDir: "/tmp",
    maxFileSize: 8 * 1024 * 1024,
    filter: ({ mimetype }) => /image\/(jpeg|png|webp|heic|heif)/.test(mimetype || "")
  });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ error: "File upload error" });

    const src = pickFile(files.source);
    const tgt = pickFile(files.target);
    if (!src || !tgt) return res.status(400).json({ error: "Need two photos" });

    const results = [];
    let echoB64 = "";
    try { echoB64 = fs.readFileSync(src.filepath).toString("base64"); }
    catch { return res.status(500).json({ error: "Temp file not found" }); }

    // 4) OpenAI 客户端（有 KEY 且未启用 USE_ECHO 时才真正调用）
    const client = process.env.OPENAI_API_KEY && process.env.USE_ECHO !== "1"
      ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
      : null;

    for (const sceneName of SCENES) {
      const sceneStream = readLocal(sceneName);
      if (!sceneStream) { results.push({ scene: sceneName, b64: echoB64, note: "scene missing" }); continue; }

      // ======= 假合成预览路径（无 KEY 或 USE_ECHO=1）=======
      if (!client) {
        try {
          // 如果装了 sharp：把“源脸缩略图”贴到底图右下角，并加场景名水印
          if (sharp) {
            const sceneBuf = fs.readFileSync(scenePath(sceneName));
            const srcBuf = fs.readFileSync(src.filepath);

            const meta = await sharp(sceneBuf).metadata();
            const baseW = meta.width || 1024;
            const baseH = meta.height || 1024;
            const thumbW = Math.max(120, Math.round(baseW * 0.22));
            const srcThumb = await sharp(srcBuf).resize({ width: thumbW }).png().toBuffer();
            const srcMeta = await sharp(srcThumb).metadata();
            const left = baseW - (srcMeta.width || thumbW) - 24;
            const top  = baseH - (srcMeta.height || Math.round(thumbW)) - 24;

            // 叠加“场景名”小标签（用 SVG 文字）
            const label = sceneName.replace(/\.(png|jpg|jpeg|webp)$/i, "");
            const fontSize = Math.max(20, Math.round(baseW * 0.03));
            const svg = Buffer.from(
              `<svg width="${baseW}" height="${baseH}">
                 <rect x="20" y="20" width="${label.length * (fontSize * 0.7) + 32}" height="${fontSize + 16}" rx="8" ry="8" fill="rgba(0,0,0,0.5)"/>
                 <text x="32" y="${20 + fontSize}" font-size="${fontSize}" fill="#fff" font-family="Arial,sans-serif">${label}</text>
               </svg>`
            );

            const out = await sharp(sceneBuf)
              .composite([
                { input: srcThumb, left, top },
                { input: svg }
              ])
              .png()
              .toBuffer();

            results.push({ scene: sceneName, b64: out.toString("base64"), note: "fake-preview" });
          } else {
            // 没装 sharp：起码返回“不同的场景底图”，也比 10 张相同源图更像回事
            const sceneOnlyB64 = fs.readFileSync(scenePath(sceneName)).toString("base64");
            results.push({ scene: sceneName, b64: sceneOnlyB64, note: "scene-only" });
          }
          continue;
        } catch (e) {
          console.warn("fake preview fail", sceneName, e?.message);
          results.push({ scene: sceneName, b64: echoB64, note: "echo" });
          continue;
        }
      }

      // ======= 真实 OpenAI 生成路径（保留你的实现）=======
      try {
        // 提示：若 SDK 对 images.generate 不接受 image 数组，请改为 images.edits 版本
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

    // 5) 记一次免费（有 Upstash 才写入）
    try { if (redisClient) await redisClient.set(key, "1", { ex: 60 * 60 * 24 * 365 }); }
    catch (e) { console.warn("Upstash set failed:", e?.message); }

    // 6) 清理临时文件
    try { fs.unlinkSync(src.filepath); } catch {}
    try { fs.unlinkSync(tgt.filepath); } catch {}

    return res.status(200).json({ images: results, email });
  });
}
