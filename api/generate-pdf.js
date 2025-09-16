export const config = { runtime: "nodejs" };

import PDFDocument from "pdfkit";

// 允许的前端域名（和其他接口一致，可用 env 支持多域）
const ORIGINS = (process.env.FRONTEND_ORIGIN || "https://face-swap-site.vercel.app")
  .split(",")
  .map(s => s.trim());

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
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

function safeParseBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === "string") return JSON.parse(req.body);
    return req.body;
  } catch {
    return "__PARSE_ERROR__";
  }
}

export default async function handler(req, res) {
  if (setCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });

  const body = safeParseBody(req);
  if (body === "__PARSE_ERROR__") {
    return res.status(400).json({ error: "Bad JSON" });
  }

  const { images, orderId } = body || {};
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "No images" });
  }

  // 响应头要在 pipe 之前设置
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename=faceswap-${orderId || "preview"}.pdf`
  );
  // 禁止缓存（预览更安全）
  res.setHeader("Cache-Control", "no-store");

  // 直接流式输出，避免大文件占用内存
  const doc = new PDFDocument({ autoFirstPage: false });
  doc.pipe(res);

  for (const it of images) {
    try {
      const imgBuf = Buffer.from(it.b64, "base64");
      const img = doc.openImage(imgBuf); // 拿到真实宽高
      doc.addPage({ size: [img.width, img.height], margin: 0 });
      doc.image(img, 0, 0);

      // 预览水印（可调淡/关）
      doc.save();
      doc.fillColor("#ffffff").fontSize(Math.max(24, Math.floor(img.width * 0.03)));
      doc.opacity(0.6);
      doc.text("PREVIEW • 非商业使用", 20, 20);
      doc.restore();
      doc.opacity(1);
    } catch (e) {
      // 单张失败则给占位页，避免整份 PDF 失败
      doc.addPage({ size: "A4", margin: 48 });
      doc
        .fontSize(18)
        .fillColor("#333")
        .text("图片无法解析", { align: "center" })
        .moveDown()
        .fontSize(12)
        .fillColor("#666")
        .text(
          "This page could not render the provided image (invalid base64).",
          { align: "center" }
        );
    }
  }

  doc.end();
}
