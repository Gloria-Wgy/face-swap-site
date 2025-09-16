// file: api/faceswap-pdf.js
export const config = { runtime: "nodejs" };

import handlerBatch from "./faceswap-batch.js";
import PDFDocument from "pdfkit";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });

  // 1) 先跑 faceswap-batch 得到 images[]
  const batchRes = await new Promise((resolve) => {
    const fakeRes = {
      status: (code) => ({
        json: (obj) => resolve({ code, obj })
      })
    };
    handlerBatch(req, fakeRes);
  });

  if (batchRes.code !== 200) {
    return res.status(batchRes.code).json(batchRes.obj);
  }

  const { images, email } = batchRes.obj;

  // 2) 拼 PDF
  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  doc.on("end", () => {
    const pdf = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=faceswap-${email || "preview"}.pdf`);
    res.end(pdf);
  });

  for (const it of images) {
    const img = Buffer.from(it.b64, "base64");
    const imgObj = doc.openImage(img);
    doc.addPage({ size: [imgObj.width, imgObj.height], margin: 0 });
    doc.image(imgObj, 0, 0);
    doc.fontSize(16).fillColor("red").opacity(0.6).text("PREVIEW", 20, 20);
    doc.opacity(1);
  }

  doc.end();
}
