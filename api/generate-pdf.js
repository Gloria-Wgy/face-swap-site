export const config = { runtime: "nodejs" };

import PDFDocument from "pdfkit";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });

  const { images, orderId } = req.body || {};
  if (!images?.length) return res.status(400).json({ error: "No images" });

  const doc = new PDFDocument({ autoFirstPage:false });
  const chunks = [];
  doc.on("data", c => chunks.push(c));
  doc.on("end", () => {
    const pdf = Buffer.concat(chunks);
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`inline; filename=faceswap-${orderId||"preview"}.pdf`);
    res.end(pdf);
  });

  // 水印（预览）
  for (const it of images) {
    const img = Buffer.from(it.b64, "base64");
    const imgObj = doc.openImage(img);
    doc.addPage({ size: [imgObj.width, imgObj.height], margin: 0 });
    doc.image(imgObj, 0, 0);
    doc.fontSize(14).fillColor("#ffffff").opacity(0.6)
       .text("PREVIEW • 非商业使用", 20, 20);
    doc.opacity(1);
  }
  doc.end();
}
