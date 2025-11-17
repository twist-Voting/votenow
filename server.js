import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import bodyParser from "body-parser";
import session from "express-session";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import archiver from "archiver";

const app = express();
const __dirname = path.resolve();
const DATA_DIR = path.join(__dirname, "data");
const TOKEN_DIR = path.join(__dirname, "pdf_tokens");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });

// ✅ CORS 設定
app.use(cors({
  origin: "https://votenow-bn56.onrender.com",
  credentials: true
}));

app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ✅ Session 設定
app.use(session({
  secret: "votenow-super-secret-key",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: "none",
    secure: process.env.NODE_ENV === "production"
  }
}));

// ✅ 靜態檔案
app.use(express.static(path.join(__dirname, "public")));

// ✅ 管理員帳號
const ADMIN_USER = "admin";
const ADMIN_PASS = "votenow123";

// ✅ 工具函式
const getFile = (session, name) => path.join(DATA_DIR, `${session}_${name}.json`);
const loadJSON = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
const saveJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ✅ 登入相關 API
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    res.json({ success: true, message: "登入成功" });
  } else {
    res.status(401).json({ success: false, message: "帳號或密碼錯誤" });
  }
});

app.get("/api/admin/status", (req, res) => {
  res.json({ loggedIn: !!req.session.isAdmin });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true, message: "已登出" }));
});

// ✅ 登入驗證中介層
function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ success: false, message: "未登入" });
  next();
}

// ✅ 候選人管理
app.get("/api/candidates", requireAdmin, (req, res) => {
  const { session } = req.query;
  res.json(loadJSON(getFile(session, "candidates")));
});

app.post("/api/candidates", requireAdmin, (req, res) => {
  const { session, names } = req.body;
  const candidates = names.map((name) => ({ name, votes: 0 }));
  saveJSON(getFile(session, "candidates"), candidates);
  res.json({ success: true });
});

// ✅ 投票碼生成
app.get("/api/generate-tokens", requireAdmin, (req, res) => {
  const { session, count = 100 } = req.query;
  const file = getFile(session, "tokens");
  const existing = loadJSON(file);
  const newTokens = Array.from({ length: parseInt(count) }, () => ({
    code: Math.random().toString(36).substring(2, 8).toUpperCase(),
    voted: false
  }));
  saveJSON(file, [...existing, ...newTokens]);
  res.json({ success: true, count: newTokens.length });
});

// ✅ 投票進度
app.get("/api/progress", requireAdmin, (req, res) => {
  const { session } = req.query;
  const tokens = loadJSON(getFile(session, "tokens"));
  const voted = tokens.filter(t => t.voted).length;
  res.json({ voted, total: tokens.length });
});

// ✅ 匯出 PDF
app.get("/api/export-pdf", requireAdmin, async (req, res) => {
  const { session } = req.query;
  const tokens = loadJSON(getFile(session, "tokens"));
  if (!tokens.length) return res.status(400).send("尚未產生投票碼");

  const outDir = path.join(TOKEN_DIR, session);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const fontPath = path.join(__dirname, "NotoSansTC-VariableFont_wght.ttf");
  for (const t of tokens) {
    const doc = new PDFDocument();
    const output = path.join(outDir, `${session}-${t.code}.pdf`);
    const stream = fs.createWriteStream(output);
    doc.pipe(stream);
    if (fs.existsSync(fontPath)) doc.font(fontPath);

    doc.fontSize(18).text(`第八屆 台灣女科技人學會 ${session}選舉`, { align: "center" });
    doc.moveDown();
    doc.text(session.includes("監事")
      ? "監事選舉請勾選 5 人，票數最高之 5 人當選，1 人候補。"
      : "理事選舉請勾選 15 人，票數最高之 15 人當選，3 人候補。");
    doc.moveDown();

    const qrUrl = `https://votenow-bn56.onrender.com?session=${session}&code=${t.code}`;
    const qrData = await QRCode.toDataURL(qrUrl);
    doc.image(Buffer.from(qrData.split(",")[1], "base64"), { fit: [150, 150], align: "center" });
    doc.moveDown();
    doc.fontSize(16).text(`投票碼：${t.code}`, { align: "center" });

    doc.end();
    await new Promise(resolve => stream.on("finish", resolve));
  }

  res.send(`✅ 已為 ${tokens.length} 組投票碼產生 PDF`);
});

// ✅ 下載 PDF ZIP
app.get("/api/download-pdf", requireAdmin, (req, res) => {
  const { session } = req.query;
  const dir = path.join(TOKEN_DIR, session);
  const zipName = `${session}_pdf.zip`;
  const zipPath = path.join(TOKEN_DIR, zipName);

  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(output);
  archive.directory(dir, false);
  archive.finalize();

  output.on("close", () => {
    res.download(zipPath, zipName);
  });
});

// ✅ 重置投票紀錄（保留投票碼）
app.delete("/api/reset", requireAdmin, (req, res) => {
  const { session } = req.query;
  const tokens = loadJSON(getFile(session, "tokens"));
  tokens.forEach(t => t.voted = false);
  saveJSON(getFile(session, "tokens"), tokens);
  saveJSON(getFile(session, "votes"), []);
  res.json({ success: true });
});

// ✅ 投票提交
app.post("/api/vote", async (req, res) => {
  const { session, code, choices } = req.body;
  const tokenFile = getFile(session, "tokens");
  const tokens = loadJSON(tokenFile);
  const token = tokens.find(t => t.code === code);
  if (!token) return res.status(400).json({ success: false, message: "投票碼錯誤" });
  if (token.voted) return res.status(400).json({ success: false, message: "已投過票" });

  token.voted = true;
  saveJSON(tokenFile, tokens);

  const votes = loadJSON(getFile(session, "votes"));
  votes.push({ code, choices });
  saveJSON(getFile(session, "votes"), votes);

  res.json({ success: true });
});
// ✅ 取得投票碼清單
app.get("/api/tokens", requireAdmin, (req, res) => {
  const { session } = req.query;
  const file = getFile(session, "tokens");
  if (!fs.existsSync(file)) {
    return res.json([]); // 若尚未產生，回傳空陣列避免報錯
  }
  const tokens = loadJSON(file);
  res.json(tokens);
});

// ✅ 統計結果
app.get("/api/result", requireAdmin, (req, res) => {
  const { session } = req.query;
  const candidates = loadJSON(getFile(session, "candidates"));
  const votes = loadJSON(getFile(session, "votes"));
  const tally = Object.fromEntries(candidates.map(c => [c.name, 0]));

  votes.forEach(v => v.choices.forEach(name => {
    if (tally[name] !== undefined) tally[name]++;
  }));

  const result = Object.entries(tally)
    .map(([name, votes]) => ({ name, votes }))
    .sort((a,b) => b.votes - a.votes);

  res.json(result);
});

// ✅ 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ VoteNow 多場版啟動於 port ${PORT}`);
});
