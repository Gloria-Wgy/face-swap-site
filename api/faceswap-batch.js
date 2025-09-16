// file: api/faceswap-batch.js
export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import PDFDocument from "pdfkit";
import { Redis } from "@upstash/redis";

// ===== Upstash（未配置则跳过限次） =====
const redisClient =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
    : null;

// ===== CORS 白名单（逗号分隔） =====
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || "https://face-swap-site.vercel.app")
  .split(",")
  .map((s) => s.trim());

// ===== 场景文件名（与 /scenes 严格一致）=====
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
  "Scientist.png",
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

const pickFile = (f) => (Array.isArray(f) ? f[0] : f) || null;
const sceneAbs = (name) => path.join(process.cwd(), "scenes", name);
const readSceneB64 = (name) => {
  const p = sceneAbs(name);
  return fs.existsSync(p) ? fs.readFileSync(p).toString("base64") : null;
};
const readSceneStream = (name) => {
  const p = sceneAbs(name);
  return fs.existsSync(p) ? fs.createReadStream(p) : null;
};

export default async function handler(req, res) {
  if (setCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });

  // 1) JWT
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: "No token" });

  let email;
  try {
    ({ email } = jwt.verify(token, process.env.JWT_SECRET));
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  // 2) 免费 10 次
  const key = "free_count:" + crypto.createHash("sha256").update(email).digest("hex");
  try {
    if (redisClient) {
      const current = await redisClient.get(key);
      const used = parseInt(current || "0", 10);
      if (used >= 10) {
        return res.status(403).json({ error: "已用完 10 次免费机会", used, remaining: 0 });
      }
    }
  } catch (e) {
    console.warn("Upstash get failed:", e?.message);
  }

  // 3) 解析上传
  const form = formidable({
    multiples: true,
    keepExtensions: true,
    uploadDir: "/tmp",
    maxFileSize: 8 * 1024 * 1024,
    filter: ({ mimetype }) => /image\/(jpeg|png|webp|heic|heif)/.test(mimetype || ""),
  });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ error: "File upload error" });

    const src = pickFile(files.source);
    const tgt = pickFile(files.target);
    if (!src || !tgt) return res.status(400).json({ error: "Need two photos" });

    let srcB64 = "";
    try {
      srcB64 = fs.readFileSync(src.filepath).toString("base64");
    } catch {
      return res.status(500).json({ error: "Temp file not found" });
    }

    const results = []; // { scene, b64 }

    // 4) OpenAI / 占位
    const useOpenAI = Boolean(process.env.OPENAI_API_KEY) && process.env.USE_ECHO !== "1";
    const client = useOpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

    for (const sceneName of SCENES) {
      const sceneB64 = readSceneB64(sceneName);
      if (!sceneB64) {
        // 场景缺失：用源图占位，保证 10 页
        results.push({ scene: sceneName, b64: srcB64, note: "scene-missing" });
        continue;
      }

      if (!client) {
        // 无 OpenAI：直接用场景图，保证 10 张
        results.push({ scene: sceneName, b64: sceneB64, note: "scene-only" });
        continue;
      }

      try {
        const r = await client.images.generate({
          model: "gpt-image-1",
          prompt:
            "Replace the main person's face in the scene with the person from the two reference photos. Natural blend, keep pose/body/lighting.",
          image: [readSceneStream(sceneName), fs.createReadStream(src.filepath), fs.createReadStream(tgt.filepath)],
          size: "768x768",
          response_format: "b64_json",
        });
        const b64 = r?.data?.[0]?.b64_json || sceneB64;
        results.push({ scene: sceneName, b64 });
      } catch (e) {
        console.error("openai fail", sceneName, e?.message);
        // 失败回退：仍然返回场景图，保证 PDF 完整
        results.push({ scene: sceneName, b64: sceneB64, note: "fallback-scene" });
      }
    }

    // 5) 计数 +1
    try {
      if (redisClient) {
        await redisClient.incr(key);
        await redisClient.expire(key, 60 * 60 * 24 * 365);
      }
    } catch (e) {
      console.warn("Upstash incr/expire failed:", e?.message);
    }

    // 6) 清理临时
    try { fs.unlinkSync(src.filepath); } catch {}
    try { fs.unlinkSync(tgt.filepath); } catch {}

    // 7) 返回 PDF
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=faceswap-${email || "preview"}.pdf`);
    res.setHeader("Cache-Control", "no-store");

    const doc = new PDFDocument({ autoFirstPage: false });
    doc.pipe(res);

    for (const it of results) {
      try {
        const imgBuf = Buffer.from(it.b64, "base64");
        const img = doc.openImage(imgBuf);
        doc.addPage({ size: [img.width, img.height], margin: 0 });
        doc.image(img, 0, 0);

        // 水印
        doc.save();
        doc.fillColor("#ffffff").fontSize(Math.max(24, Math.floor(img.width * 0.03)));
        doc.opacity(0.6).text("PREVIEW • 非商业使用", 20, 20);
        doc.restore().opacity(1);

        // 场景名
        doc.save();
        doc.opacity(0.7).fillColor("#000000").fontSize(14);
        doc.text(it.scene, 20, img.height - 36);
        doc.restore().opacity(1);
      } catch {
        doc.addPage({ size: "A4", margin: 48 });
        doc.fontSize(18).fillColor("#333").text("图片渲染失败", { align: "center" })
           .moveDown().fontSize(12).fillColor("#666")
           .text(`Scene: ${it.scene}`, { align: "center" });
      }
    }

    doc.end();
  });
}
