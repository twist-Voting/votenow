import express from "express";
import fs from "fs";
import path from "path";
import bodyParser from "body-parser";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const TOKEN_DIR = path.join(__dirname, "pdf_tokens");
if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });

// 🧠 工具函式：處理 JSON 檔案
function getFile(session, type) {
  return path.join(TOKEN_DIR, `${session}_${type}.json`);
}

function loadJSON(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch (err) {
    console.error("讀取 JSON 錯誤：", err);
  }
  return [];
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

// ✅ 產生亂碼 Token
function generateToken() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let token = "";
  for (let i = 0; i < 6; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

// ✅ 產生投票碼
app.get("/api/generate-tokens", (req, res) => {
  const session = req.query.session || "理事";
  const count = Number(req.query.count) || 50;
  const file = getFile(session, "tokens");

  let tokens = loadJSON(file);
  const newTokens = [];

  for (let i = 0; i < count; i++) {
    const code = generateToken();
    tokens.push({ code, used: false });
    newTokens.push(code);
  }

  saveJSON(file, tokens);
  res.json({ success: true, session, count, tokens: newTokens });
});

// ✅ 投票提交
app.post("/api/vote", (req, res) => {
  const { code, choices, session } = req.body;
  if (!code || !choices || !session) return res.json({ success: false, error: "缺少必要參數" });

  const file = getFile(session, "tokens");
  const tokens = loadJSON(file);
  const token = tokens.find((t) => t.code === code);

  if (!token) return res.json({ success: false, error: "無效的投票碼" });
  if (token.used) return res.json({ success: false, error: "此投票碼已使用" });

  token.used = true;
  token.choices = choices;
  saveJSON(file, tokens);

  res.json({ success: true });
});

// ✅ 管理者登入
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD || password === "twist2024") {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: "密碼錯誤" });
  }
});

// ✅ 匯出 PDF（Render 雲端安全版）
app.get("/api/export-pdf", async (req, res) => {
  try {
    const session = req.query.session || "理事";
    const file = getFile(session, "tokens");
    const tokens = loadJSON(file);
    if (!tokens.length) return res.status(400).send("❌ 尚未產生投票碼");

    const outDir = path.join(TOKEN_DIR, session);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    for (const t of tokens) {
      const doc = new PDFDocument();
      const output = path.join(outDir, `${session}-${t.code}.pdf`);
      const stream = fs.createWriteStream(output);
      doc.pipe(stream);

      try {
        doc.font("/Users/wlan/Library/Fonts/NotoSansTC[wght].ttf");
      } catch {
        doc.font("Helvetica-Bold");
      }

      doc.fontSize(18).text(`第八屆 台灣女科技人學會 會員大會 ${session}選舉`, { align: "center" });
      doc.moveDown();
      doc.fontSize(14).text("投票說明：");

      if (session.includes("監事")) {
        doc.text("監事選舉請勾選 5 人，票數最高之 5 人當選，1 人候補。");
      } else {
        doc.text("理事選舉請勾選 15 人，票數最高之 15 人當選，3 人候補。");
      }

      doc.moveDown();

      const qrUrl = `https://votenow-bn56.onrender.com?session=${session}&code=${t.code}`;
      const qrData = await QRCode.toDataURL(qrUrl);
      doc.image(Buffer.from(qrData.split(",")[1], "base64"), {
        fit: [150, 150],
        align: "center",
      });

      doc.moveDown();
      doc.fontSize(16).text(`投票碼：${t.code}`, { align: "center" });
      doc.end();
      await new Promise((resolve) => stream.on("finish", resolve));
    }

    res.send(`✅ 已成功產生 ${tokens.length} 組「${session}」投票 PDF！`);
  } catch (err) {
    console.error("PDF export error:", err);
    res.status(500).send("❌ 產生 PDF 時發生錯誤：" + err.message);
  }
});

// ✅ 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ VoteNow 多場版啟動於 port ${PORT}`);
});
