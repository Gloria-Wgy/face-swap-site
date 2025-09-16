export const config = { runtime: "nodejs" };
import jwt from "jsonwebtoken";
import crypto from "crypto";
// 这里省略真正发邮件的代码，先返回链接给前端演示

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({error:"Only POST"});
  const { email } = req.body || {};
  if (!email) return res.status(400).json({error:"Email required"});

  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const link = `${process.env.PUBLIC_BASE_URL}/upload.html?token=${token}`;
  // TODO: 真正发邮件：把 link 发给用户
  return res.status(200).json({ link }); // MVP: 直接返回链接
}
