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

// ===== 可配置 CORS 白名单（逗号分隔），默认你的域名 =====
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || "https://face-swap-site.vercel.app")
  .split(",").map(s => s.trim());

// ===== 场景文件名（与 /scenes 目录严格一致，区分大小写）=====
const SCENES = [
  "Actor.png","Artist.png","Astronaut.png","Athlete.png","Doctor.png",
  "Firefighter.png","Lawyer.png","Musician.png","Policeman.png","Scientist.png"
];

// ===== 可选的“假预览”合成：贴缩略图+标签 =====
let sharp = null;
try { sharp = (await import("sharp")).default; } catch { /* 若未安装则退化 */ }

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
const sceneAbs = name => path.join(process.cwd(), "scenes", name);
const readLocalStream = name => fs.existsSync(sceneAbs(name)) ? fs.createReadStream(sceneAbs(name)) : null;

export default async function handler(req, res) {
  if (setCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });

  // 1) JWT token
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: "No token" });

  let email;
  try { ({ email } = jwt.verify(token, process.env.JWT_SECRET)); }
  catch { return res.status(401).json({ error: "Invalid token" }); }

  // 2) 免费一次（Upstash）
  const key = "free_used:" + crypto.createHash("sha256").update(email).digest("hex");
  try {
    if (redisClient) {
      const used = await redisClient.get(key);
      if (used === "1") return res.status(403).json({ error: "Free chance already used" });
    }
  } catch (e) {
    console.warn("Upstash get failed:", e?.message);
  }

  // 3) 解析上传表单
  const form = formidable({
    multiples: true,
    keepExtensions: true,
    uploadDir: "/tmp",
    maxFileSize: 8 * 1024 * 1024,
    filter: ({ mimetype }) => /image\/(jpeg|png|webp|heic|heif)/.test(mimetype || "")
  });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ error: "File upload error" });

    const src = pickFile(files.source);
    const tgt = pickFile(files.target);
    if (!src || !tgt) return res.status(400).json({ error: "Need two photos" });

    let srcB64 = "";
    try { srcB64 = fs.readFileSync(src.filepath).toString("base64"); }
    catch { return res.status(500).json({ error: "Temp file not found" }); }

    const results = []; // { scene, b64 } 列表（最终用于组装 PDF）

    // 4) 决定是否调用 OpenAI
    const useOpenAI = Boolean(process.env.OPENAI_API_KEY) && process.env.USE_ECHO !== "1";
    const client = useOpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

    for (const sceneName of SCENES) {
      const scenePath = sceneAbs(sceneName);
      if (!fs.existsSync(scenePath)) {
        // 若场景缺失，至少返回源图做占位
        results.push({ scene: sceneName, b64: srcB64, note: "scene-missing" });
        continue;
      }

      // —— 无 OpenAI 或强制回显：走“假合成预览” —— //
      if (!client) {
        try {
          if (sharp) {
            const baseBuf = fs.readFileSync(scenePath);
            const srcBuf = fs.readFileSync(src.filepath);

            const meta = await sharp(baseBuf).metadata();
            const W = meta.width || 1024, H = meta.height || 1024;
            const thumbW = Math.max(120, Math.round(W * 0.22));
            const srcThumb = await sharp(srcBuf).resize({ width: thumbW }).png().toBuffer();
            const srcMeta = await sharp(srcThumb).metadata();
            const margin = 24;
            const left = W - (srcMeta.width || thumbW) - margin;
            const top  = H - (srcMeta.height || Math.round(thumbW)) - margin;

            const label = sceneName.replace(/\.(png|jpg|jpeg|webp)$/i, "");
            const fontSize = Math.max(20, Math.round(W * 0.03));
            const svg = Buffer.from(
              `<svg width="${W}" height="${H}">
                 <rect x="20" y="20" width="${label.length * (fontSize * 0.7) + 32}" height="${fontSize + 16}" rx="8" ry="8" fill="rgba(0,0,0,0.5)"/>
                 <text x="32" y="${20 + fontSize}" font-size="${fontSize}" fill="#fff" font-family="Arial,sans-serif">${label}</text>
               </svg>`
            );

            const out = await sharp(baseBuf)
              .composite([{ input: srcThumb, left, top }, { input: svg }])
              .png()
              .toBuffer();

            results.push({ scene: sceneName, b64: out.toString("base64"), note: "fake-preview" });
          } else {
            // 未安装 sharp：直接返回场景原图，确保 10 张不相同
            const sceneOnlyB64 = fs.readFileSync(scenePath).toString("base64");
            results.push({ scene: sceneName, b64: sceneOnlyB64, note: "scene-only" });
          }
          continue;
        } catch (e) {
          console.warn("fake preview fail", sceneName, e?.message);
          results.push({ scene: sceneName, b64: srcB64, note: "echo" });
          continue;
        }
      }

      // —— OpenAI 路径（如失败自动回退） —— //
      try {
        // 若 SDK 不支持 images.generate 的 image 数组，可改成 images.edits 通路
        const r = await client.images.generate({
          model: "gpt-image-1",
          prompt: "Replace the main person's face in the scene with the person from the two reference photos. Natural blend, keep pose/body/lighting.",
          image: [readLocalStream(sceneName), fs.createReadStream(src.filepath), fs.createReadStream(tgt.filepath)],
          size: "768x768",
          response_format: "b64_json"
        });
        const b64 = r?.data?.[0]?.b64_json || srcB64;
        results.push({ scene: sceneName, b64 });
      } catch (e) {
        console.error("openai fail", sceneName, e?.message);
        try {
          // 尝试回退到“假预览”
          if (sharp) {
            const baseBuf = fs.readFileSync(scenePath);
            const srcBuf = fs.readFileSync(src.filepath);
            const out = await sharp(baseBuf).composite([
              { input: await sharp(srcBuf).resize({ width: 200 }).png().toBuffer(), left: 24, top: 24 }
            ]).png().toBuffer();
            results.push({ scene: sceneName, b64: out.toString("base64"), note: "fallback-fake" });
          } else {
            const sceneOnlyB64 = fs.readFileSync(scenePath).toString("base64");
            results.push({ scene: sceneName, b64: sceneOnlyB64, note: "fallback-scene" });
          }
        } catch {
          results.push({ scene: sceneName, b64: srcB64, note: "fallback-echo" });
        }
      }
    }

    // 5) 记一次免费（成功走完整流程即记一次；如需“成功才记”，可增加判断）
    try { if (redisClient) await redisClient.set(key, "1", { ex: 60 * 60 * 24 * 365 }); }
    catch (e) { console.warn("Upstash set failed:", e?.message); }

    // 6) 清理临时文件
    try { fs.unlinkSync(src.filepath); } catch {}
    try { fs.unlinkSync(tgt.filepath); } catch {}

    // 7) 直接生成并返回 PDF（二进制流）
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

        // 预览水印
        doc.save();
        doc.fillColor("#ffffff").fontSize(Math.max(24, Math.floor(img.width * 0.03)));
        doc.opacity(0.6).text("PREVIEW • 非商业使用", 20, 20);
        doc.restore().opacity(1);

        // 页脚场景名
        doc.save();
        doc.opacity(0.7).fillColor("#000000").fontSize(14);
        doc.text(it.scene, 20, img.height - 36);
        doc.restore().opacity(1);
      } catch {
        // 单张失败则给占位页
        doc.addPage({ size: "A4", margin: 48 });
        doc.fontSize(18).fillColor("#333").text("图片渲染失败", { align: "center" })
           .moveDown().fontSize(12).fillColor("#666")
           .text(`Scene: ${it.scene}`, { align: "center" });
      }
    }

    doc.end();
  });
}
