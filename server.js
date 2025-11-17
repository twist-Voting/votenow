import express from "express";
import fs from "fs";
import path from "path";
import bodyParser from "body-parser";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import cors from "cors";
import session from "express-session";
import cookieParser from "cookie-parser";

const app = express();
const __dirname = path.resolve();
const DATA_DIR = path.join(__dirname, "data");
const TOKEN_DIR = path.join(__dirname, "pdf_tokens");

// === 建立資料夾 ===
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR);

// === Middleware ===
app.use(cors());
app.use(express.static("public"));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(
  session({
    secret: "votenow-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 1天
    },
  })
);

// === 共用工具函式 ===
function getFile(session, type) {
  return path.join(DATA_DIR, `${session}_${type}.json`);
}

function loadJSON(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// === 管理者登入 ===
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "admin" && password === "votenow123") {
    req.session.isAdmin = true;
    res.cookie("isAdmin", "true", { httpOnly: false });
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, error: "帳號或密碼錯誤" });
});

// === 自動登入檢查 ===
app.get("/api/admin/check", (req, res) => {
  if (req.session.isAdmin) {
    return res.json({ isAdmin: true });
  }
  res.json({ isAdmin: false });
});

// === 權限保護 ===
function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).send("Unauthorized");
  next();
}

// === 設定候選人名單 ===
app.post("/api/candidates", (req, res) => {
  const { session, names } = req.body;
  const file = getFile(session, "candidates");
  saveJSON(file, names.map((n, i) => ({ id: i + 1, name: n.trim() })));
  res.json({ success: true });
});

// === 取得候選人名單 ===
app.get("/api/candidates", (req, res) => {
  const { session } = req.query;
  const file = getFile(session, "candidates");
  res.json(loadJSON(file));
});

// === 產生投票碼 ===
app.get("/api/generate-tokens", (req, res) => {
  const { session, count } = req.query;
  const tokenFile = getFile(session, "tokens");
  const num = Number(count) || 50;
  const tokens = Array.from({ length: num }, () => ({
    code: Math.random().toString(36).substring(2, 8).toUpperCase(),
    voted: false,
  }));
  saveJSON(tokenFile, tokens);
  res.json({ success: true, tokens });
});

// === 取得投票碼清單 ===
app.get("/api/tokens", (req, res) => {
  const { session } = req.query;
  const file = getFile(session, "tokens");
  res.json(loadJSON(file));
});

// === 投票提交 ===
app.post("/api/vote", (req, res) => {
  const { code, choices, session } = req.body;
  const tokenFile = getFile(session, "tokens");
  const voteFile = getFile(session, "votes");

  const tokens = loadJSON(tokenFile);
  const token = tokens.find((t) => t.code === code);
  if (!token) return res.status(400).json({ success: false, error: "投票碼無效" });
  if (token.voted) return res.status(400).json({ success: false, error: "此投票碼已使用" });

  const votes = loadJSON(voteFile);
  votes.push({ code, choices, time: new Date().toISOString() });
  token.voted = true;

  saveJSON(tokenFile, tokens);
  saveJSON(voteFile, votes);
  res.json({ success: true });
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

// === 檢查投票碼有效性 ===
app.get("/api/check", (req, res) => {
  const { code, session } = req.query;
  const tokens = loadJSON(getFile(session, "tokens"));
  const token = tokens.find((t) => t.code === code);
  if (!token) return res.json({ valid: false });
  if (token.voted) return res.json({ valid: true, voted: true });
  res.json({ valid: true });
});

// === 查看投票進度 ===
app.get("/api/progress", (req, res) => {
  const { session } = req.query;
  const votes = loadJSON(getFile(session, "votes"));
  res.json({ total: votes.length });
});

// === 重新投票（不刪投票碼） ===
app.post("/api/reset", (req, res) => {
  const { session } = req.body;
  const tokenFile = getFile(session, "tokens");
  const voteFile = getFile(session, "votes");

  const tokens = loadJSON(tokenFile).map((t) => ({ ...t, voted: false }));
  saveJSON(tokenFile, tokens);
  saveJSON(voteFile, []);
  res.json({ success: true });
});

// === 匯出 PDF（中文 + QR code） ===
app.get("/api/export-pdf", async (req, res) => {
  const { session } = req.query;
  const tokens = loadJSON(getFile(session, "tokens"));
  const fontPath = path.join(__dirname, "NotoSansTC-VariableFont_wght.ttf");
  if (!tokens.length) return res.status(400).send("尚未產生投票碼");

  const outDir = path.join(TOKEN_DIR, session);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const t of tokens) {
    const doc = new PDFDocument();
    const output = path.join(outDir, `${session}-${t.code}.pdf`);
    const stream = fs.createWriteStream(output);
    doc.pipe(stream);
    // doc.font("/usr/share/fonts/truetype/noto/NotoSansTC-Regular.otf");
    // doc.font(path.join(__dirname, "fonts", "NotoSansTC-VariableFont_wght.ttf"));
    if (fs.existsSync(fontPath)) doc.font(fontPath);

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

  res.send(`✅ 已為 ${tokens.length} 組「${session}」投票碼產生 PDF，儲存在 /pdf_tokens/${session}/`);
});

// === 啟動伺服器 ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ VoteNow 多場版啟動於 port ${PORT}`);
});
