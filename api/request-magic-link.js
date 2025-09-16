export const config = { runtime: "nodejs" };

import jwt from "jsonwebtoken";

// 允许前端域名：支持从环境变量配置多个，逗号分隔
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

// 简单邮箱校验（MVP）
function isEmail(x) {
  return typeof x === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
}

export default async function handler(req, res) {
  if (setCors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST" });
  }

  // 环境变量检查
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: "Missing JWT_SECRET" });
  }
  if (!process.env.PUBLIC_BASE_URL) {
    return res.status(500).json({ error: "Missing PUBLIC_BASE_URL" });
  }

  const body = safeParseBody(req);
  if (body === "__PARSE_ERROR__") {
    return res.status(400).json({ error: "Bad JSON" });
  }

  let { email } = body || {};
  if (!email) return res.status(400).json({ error: "Email required" });
  email = String(email).trim().toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: "Invalid email" });

  // 生成 1 小时有效的 token
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "1h" });

  // 你的上传页路径：若使用 vercel.json 重写到 /public/upload.html，这里仍保持 /upload.html
  const link = `${process.env.PUBLIC_BASE_URL}/upload.html?token=${encodeURIComponent(token)}`;

  // TODO(上线)：发送邮件（SendGrid/Mailgun/SES），把 link 发给用户
  // 例如：await sendMail({ to: email, subject: "上传链接", html: `<a href="${link}">点此上传</a>` });

  // MVP：直接返回给前端
  return res.status(200).json({ ok: true, email, token, link, expires_in_seconds: 3600 });
}
