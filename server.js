import express from "express";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import archiver from "archiver";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const __dirname = path.resolve(".");
const DATA_DIR = path.join(__dirname, "data");
const TOKEN_DIR = path.join(__dirname, "pdf_tokens");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR);

// 🧩 安全寫入佇列機制（避免多人同時寫入）
const writeQueue = new Map();
async function safeWriteJson(file, data) {
  if (!writeQueue.has(file)) writeQueue.set(file, Promise.resolve());
  const queue = writeQueue.get(file).then(async () => {
    await fs.promises.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  });
  writeQueue.set(file, queue);
  await queue;
}

// 🔒 簡易登入驗證
const ADMIN_USER = "admin";
const ADMIN_PASS = "vote2025";
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: "帳號或密碼錯誤" });
  }
});

// ✅ 驗證投票碼是否有效（用於投票頁初始化）
app.get("/api/check", (req, res) => {
  const { session, code } = req.query;
  const tokenFile = path.join(DATA_DIR, `${session}-tokens.json`);

  if (!fs.existsSync(tokenFile)) {
    return res.status(404).json({ valid: false, message: "投票碼檔案不存在" });
  }

  const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const token = tokens.find((t) => t.code === code);

  if (!token) {
    return res.json({ valid: false, message: "無效的投票碼" });
  }

  if (token.voted) {
    return res.json({ valid: false, message: "此投票碼已投票" });
  }

  return res.json({ valid: true });
});

// ✅ 顯示投票進度（已投票人數）
app.get("/api/progress", (req, res) => {
  const { session } = req.query;
  const tokenFile = path.join(DATA_DIR, `${session}-tokens.json`);
  if (!fs.existsSync(tokenFile)) {
    return res.json({ total: 0, voted: 0 });
  }

  const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const total = tokens.length;
  const voted = tokens.filter((t) => t.voted).length;

  res.json({ total, voted });
});

// 📋 載入候選人
app.get("/api/candidates", (req, res) => {
  const { session } = req.query;
  const file = path.join(DATA_DIR, `${session}-candidates.json`);
  if (!fs.existsSync(file)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(file)));
});

// ✏️ 儲存候選人名單
app.post("/api/candidates", async (req, res) => {
  const { session, names } = req.body;
  const file = path.join(DATA_DIR, `${session}-candidates.json`);
  await safeWriteJson(file, names.map((n, i) => ({ id: i + 1, name: n })));
  res.json({ success: true });
});

// 🔢 產生投票碼
app.get("/api/generate-tokens", async (req, res) => {
  const { session, count = 50 } = req.query;
  const file = path.join(DATA_DIR, `${session}-tokens.json`);
  const tokens = Array.from({ length: parseInt(count) }).map(() => ({
    code: Math.random().toString(36).substring(2, 8).toUpperCase(),
    voted: false,
  }));
  await safeWriteJson(file, tokens);
  res.json({ success: true, tokens });
});

// 📖 查看投票碼
app.get("/api/tokens", (req, res) => {
  const { session } = req.query;
  const file = path.join(DATA_DIR, `${session}-tokens.json`);
  if (!fs.existsSync(file)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(file)));
});

// 🗳️ 投票
app.post("/api/vote", async (req, res) => {
  const { session, code, choices } = req.body;
  const tokenFile = path.join(DATA_DIR, `${session}-tokens.json`);
  const voteFile = path.join(DATA_DIR, `${session}-votes.json`);

  if (!fs.existsSync(tokenFile))
    return res.status(400).json({ success: false, error: "投票碼不存在" });

  const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const token = tokens.find((t) => t.code === code);
  if (!token) return res.status(400).json({ success: false, error: "無效投票碼" });
  if (token.voted) return res.status(400).json({ success: false, error: "此投票碼已使用" });

  // 更新 token 狀態
  token.voted = true;
  await safeWriteJson(tokenFile, tokens);

  // 儲存投票結果
  let votes = [];
  if (fs.existsSync(voteFile)) votes = JSON.parse(fs.readFileSync(voteFile, "utf8"));
  votes.push({ code, choices });
  await safeWriteJson(voteFile, votes);

  res.json({ success: true });
});

// 📊 結果統計
app.get("/api/result", (req, res) => {
  const { session } = req.query;
  const candidateFile = path.join(DATA_DIR, `${session}-candidates.json`);
  const voteFile = path.join(DATA_DIR, `${session}-votes.json`);
  const tokenFile = path.join(DATA_DIR, `${session}-tokens.json`);

  if (!fs.existsSync(candidateFile)) return res.json({ total: 0, voted: 0, counts: [] });

  const candidates = JSON.parse(fs.readFileSync(candidateFile, "utf8"));
  const votes = fs.existsSync(voteFile) ? JSON.parse(fs.readFileSync(voteFile, "utf8")) : [];
  const tokens = fs.existsSync(tokenFile) ? JSON.parse(fs.readFileSync(tokenFile, "utf8")) : [];

  const countMap = {};
  votes.forEach((v) => v.choices.forEach((id) => (countMap[id] = (countMap[id] || 0) + 1)));

  const counts = candidates.map((c) => ({
    name: c.name,
    votes: countMap[c.id] || 0,
  }));

  res.json({
    total: tokens.length,
    voted: tokens.filter((t) => t.voted).length,
    counts,
  });
});

// 🧨 重新投票（不刪投票碼）
app.delete("/api/reset", async (req, res) => {
  const { session } = req.query;
  const tokenFile = path.join(DATA_DIR, `${session}-tokens.json`);
  const voteFile = path.join(DATA_DIR, `${session}-votes.json`);

  try {
    if (fs.existsSync(tokenFile)) {
      const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
      tokens.forEach((t) => (t.voted = false));
      await safeWriteJson(tokenFile, tokens);
    }
    if (fs.existsSync(voteFile)) fs.unlinkSync(voteFile);

    res.json({ success: true, message: `「${session}」投票已重置（保留投票碼）` });
  } catch (err) {
    res.status(500).json({ success: false, message: "重置失敗" });
  }
});

// 🧾 匯出 PDF（含 QR code 與 Render 網址）
app.get("/api/export-pdf", async (req, res) => {
  const { session } = req.query;
  const file = path.join(DATA_DIR, `${session}-tokens.json`);
  if (!fs.existsSync(file)) return res.status(400).send("尚未產生投票碼");

  const tokens = JSON.parse(fs.readFileSync(file, "utf8"));
  const outDir = path.join(TOKEN_DIR, session);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const t of tokens) {
    const doc = new PDFDocument();
    const output = path.join(outDir, `${session}-${t.code}.pdf`);
    const stream = fs.createWriteStream(output);
    doc.pipe(stream);

    // 📄 使用雲端網址（Render）
    const qrUrl = `https://votenow-bn56.onrender.com?session=${session}&code=${t.code}`;
    const qrData = await QRCode.toDataURL(qrUrl);

    try {
      doc.font("/usr/share/fonts/truetype/noto/NotoSansTC-Regular.otf");
    } catch {
      doc.font("Helvetica");
    }

    doc.fontSize(18).text(`第八屆 台灣女科技人學會 會員大會 ${session}選舉`, { align: "center" });
    doc.moveDown();
    doc.fontSize(14).text(session.includes("監事") ?
      "監事選舉請勾選 5 人，票數最高之 5 人當選，1 人候補。" :
      "理事選舉請勾選 15 人，票數最高之 15 人當選，3 人候補。");
    doc.moveDown();
    doc.image(Buffer.from(qrData.split(",")[1], "base64"), { fit: [150, 150], align: "center" });
    doc.moveDown();
    doc.fontSize(16).text(`投票碼：${t.code}`, { align: "center" });
    doc.end();
    await new Promise((resolve) => stream.on("finish", resolve));
  }

  // 打包 ZIP
  const zipPath = path.join(TOKEN_DIR, `${session}-pdfs.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip");
  archive.pipe(output);
  archive.directory(outDir, false);
  await archive.finalize();

  res.download(zipPath, `${session}-pdfs.zip`);
});

// ✅ 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ VoteNow 多場版啟動於 port ${PORT}`);
});
