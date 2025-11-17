import express from "express";
import fs from "fs";
import path from "path";
import bodyParser from "body-parser";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import cors from "cors";
import dotenv from "dotenv";
import archiver from "archiver";
// import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// ✅ 確保資料夾存在
const DATA_DIR = "./data";
const TOKEN_DIR = "./pdf_tokens";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR);

// ✅ 工具函式
function getFile(session, type) {
  return path.join(DATA_DIR, `${session}_${type}.json`);
}

function loadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch {
    return [];
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ✅ 一鍵下載 PDF 壓縮包（支援中文檔名）
app.get("/api/download-pdf", async (req, res) => {
  const { session } = req.query;
  const dir = path.join(TOKEN_DIR, session);

  if (!fs.existsSync(dir)) {
    return res.status(404).send("找不到 PDF 資料夾，請先匯出 PDF");
  }

  const zipName = `${session}_pdf_tokens.zip`;
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(zipName)}"; filename*=UTF-8''${encodeURIComponent(zipName)}`
  );
  res.setHeader("Content-Type", "application/zip");

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(res);
  archive.directory(dir, false);
  archive.finalize();
});

// 🧨 重新投票（清除投票紀錄，但保留投票碼與名單）
app.delete("/api/reset", async (req, res) => {
  const { session } = req.query;
  try {
    const tokenFile = path.join(DATA_DIR, `${session}-tokens.json`);
    const voteFile = path.join(DATA_DIR, `${session}-votes.json`);

    // 1️⃣ 如果有投票碼資料，將 voted 狀態全部重置為 false
    if (fs.existsSync(tokenFile)) {
      const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
      tokens.forEach(t => t.voted = false);
      fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), "utf8");
    }

    // 2️⃣ 刪除投票紀錄檔案（例如紀錄每位投票者的選擇）
    if (fs.existsSync(voteFile)) fs.unlinkSync(voteFile);

    res.json({ success: true, message: `「${session}」投票已重置（保留投票碼）` });
  } catch (e) {
    console.error("❌ 重置失敗：", e);
    res.status(500).json({ error: "Reset failed" });
  }
});


app.get("/api/check", (req, res) => {
  const { session, code } = req.query;
  const tokens = loadJSON(getFile(session, "tokens"));
  const votes = loadJSON(getFile(session, "votes"));
  const token = tokens.find(t => t.code === code);
  const alreadyVoted = votes.some(v => v.code === code);

  res.json({ valid: !!token && !alreadyVoted });
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

// ✅ 取得候選人名單
app.get("/api/candidates", (req, res) => {
  const { session } = req.query;
  const file = getFile(session, "candidates");
  const candidates = loadJSON(file);
  res.json(candidates);
});

// ✅ 取得目前場次的投票碼清單
app.get("/api/tokens", (req, res) => {
  const { session } = req.query;
  const file = getFile(session, "tokens");
  const tokens = loadJSON(file);
  res.json(tokens);
});

// ✅ 更新候選人名單
app.post("/api/candidates", (req, res) => {
  const { session, names } = req.body;
  if (!session || !names) {
    return res.status(400).json({ success: false, message: "缺少必要欄位" });
  }
  const file = getFile(session, "candidates");
  const candidates = names.map((name, i) => ({ id: i + 1, name }));
  saveJSON(file, candidates);
  res.json({ success: true });
});

// ✅ 產生投票碼
app.get("/api/generate-tokens", (req, res) => {
  const { session, count = 50 } = req.query;
  const tokens = Array.from({ length: Number(count) }, () => ({
    code: Math.random().toString(36).substring(2, 8).toUpperCase(),
    voted: false,
  }));
  saveJSON(getFile(session, "tokens"), tokens);
  res.json(tokens);
});

// ✅ 檢查投票碼
app.post("/api/check", (req, res) => {
  const { session, code } = req.body;
  const tokens = loadJSON(getFile(session, "tokens"));
  const token = tokens.find((t) => t.code === code);
  if (token && !token.voted) res.json({ valid: true });
  else res.json({ valid: false });
});

// ✅ 提交投票
app.post("/api/vote", (req, res) => {
  const { session, code, choices } = req.body;
  if (!session || !code || !choices) {
    return res.status(400).json({ success: false, message: "缺少必要欄位" });
  }

  const tokensFile = getFile(session, "tokens");
  const votesFile = getFile(session, "votes");
  const tokens = loadJSON(tokensFile);
  const votes = loadJSON(votesFile);

  const token = tokens.find((t) => t.code === code);
  if (!token) return res.status(400).json({ success: false, message: "投票碼不存在" });
  if (token.voted) return res.status(400).json({ success: false, message: "投票碼已使用" });

  token.voted = true;
  votes.push({ code, choices });
  saveJSON(tokensFile, tokens);
  saveJSON(votesFile, votes);

  res.json({ success: true });
});

// ✅ 取得投票進度
app.get("/api/progress", (req, res) => {
  const { session } = req.query;
  const tokens = loadJSON(getFile(session, "tokens"));
  const voted = tokens.filter((t) => t.voted).length;
  const total = tokens.length;
  res.json({ voted, total });
});

// ✅ 計算投票結果
app.get("/api/result", (req, res) => {
  const { session } = req.query;
  const candidates = loadJSON(getFile(session, "candidates"));
  const votes = loadJSON(getFile(session, "votes"));
  const results = candidates.map((c) => ({
    name: c.name,
    votes: votes.filter((v) => v.choices.includes(c.id)).length,
  }));
  results.sort((a, b) => b.votes - a.votes);
  res.json(results);
});

// 匯出 PDF
app.get("/api/export-pdf", async (req, res) => {
  const { session } = req.query;
  const file = getFile(session, "tokens");
  const tokens = loadJSON(file);
  if (!tokens.length) return res.status(400).send("尚未產生投票碼");

  const outDir = path.join(TOKEN_DIR, session);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const fontPath = path.join(__dirname, "fonts", "NotoSansTC-VariableFont_wght.ttf");

  for (const t of tokens) {
    const doc = new PDFDocument();
    const output = path.join(outDir, `${session}-${t.code}.pdf`);
    const stream = fs.createWriteStream(output);
    doc.pipe(stream);

    // ✅ 使用專案內嵌中文字型
    // doc.font(fontPath);
if (!fs.existsSync(fontPath)) {
  console.warn("⚠️ 找不到 NotoSansTC 字型，改用內建 Helvetica");
  doc.font("Helvetica");
} else {
  doc.font(fontPath);
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
    doc.image(Buffer.from(qrData.split(",")[1], "base64"), { fit: [150, 150], align: "center" });
    doc.moveDown();
    doc.fontSize(16).text(`投票碼：${t.code}`, { align: "center" });
    doc.end();

    await new Promise((resolve) => stream.on("finish", resolve));
  }

  res.send(`✅ 已為 ${tokens.length} 組「${session}」投票碼產生 PDF`);
});

// ✅ 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ VoteNow 多場版啟動於 port ${PORT}`);
});
