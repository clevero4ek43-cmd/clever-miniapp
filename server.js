const express = require("express");
const session = require("express-session");
const multer = require("multer");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "clever.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  description TEXT DEFAULT '',
  image TEXT DEFAULT '',
  category TEXT DEFAULT 'Букеты',
  visible INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  comment TEXT DEFAULT '',
  total INTEGER NOT NULL,
  items_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Новый',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "clever-local-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 12
  }
}));

app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use(express.static(__dirname));

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "clever123";

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(401).json({ error: "Требуется вход" });
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Можно загружать только изображения"));
    }
    cb(null, true);
  }
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Неверный логин или пароль" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/me", (req, res) => {
  res.json({ isAdmin: Boolean(req.session?.isAdmin) });
});

app.get("/api/products", (req, res) => {
  const products = db.prepare(`
    SELECT id, name, price, description, image, category, visible, sort_order
    FROM products
    WHERE visible = 1
    ORDER BY sort_order ASC, id DESC
  `).all();
  res.json(products);
});

app.get("/api/admin/products", requireAdmin, (req, res) => {
  const products = db.prepare(`
    SELECT id, name, price, description, image, category, visible, sort_order, created_at
    FROM products
    ORDER BY sort_order ASC, id DESC
  `).all();
  res.json(products);
});

app.post("/api/admin/upload", requireAdmin, upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не выбран" });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.post("/api/admin/products", requireAdmin, (req, res) => {
  const {
    name,
    price,
    description = "",
    image = "",
    category = "Букеты",
    visible = true,
    sort_order = 0
  } = req.body || {};

  if (!name || Number(price) <= 0) {
    return res.status(400).json({ error: "Укажите название и цену" });
  }

  const info = db.prepare(`
    INSERT INTO products (name, price, description, image, category, visible, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(name).trim(),
    Math.round(Number(price)),
    String(description || ""),
    String(image || ""),
    String(category || "Букеты"),
    visible ? 1 : 0,
    Math.round(Number(sort_order) || 0)
  );

  res.json({ id: info.lastInsertRowid });
});

app.put("/api/admin/products/:id", requireAdmin, (req, res) => {
  const {
    name,
    price,
    description = "",
    image = "",
    category = "Букеты",
    visible = true,
    sort_order = 0
  } = req.body || {};

  if (!name || Number(price) <= 0) {
    return res.status(400).json({ error: "Укажите название и цену" });
  }

  db.prepare(`
    UPDATE products
    SET name=?, price=?, description=?, image=?, category=?, visible=?, sort_order=?
    WHERE id=?
  `).run(
    String(name).trim(),
    Math.round(Number(price)),
    String(description || ""),
    String(image || ""),
    String(category || "Букеты"),
    visible ? 1 : 0,
    Math.round(Number(sort_order) || 0),
    Number(req.params.id)
  );

  res.json({ success: true });
});

app.delete("/api/admin/products/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM products WHERE id=?").run(Number(req.params.id));
  res.json({ success: true });
});

app.post("/api/orders", (req, res) => {
  const { customer_name, phone, comment = "", items = [] } = req.body || {};

  if (!customer_name || !phone || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Заполните имя, телефон и корзину" });
  }

  const normalized = items.map(item => ({
    name: String(item.name || ""),
    price: Math.round(Number(item.price) || 0),
    qty: Math.max(1, Math.round(Number(item.qty) || 1))
  })).filter(item => item.name && item.price > 0);

  const total = normalized.reduce((sum, item) => sum + item.price * item.qty, 0);

  const info = db.prepare(`
    INSERT INTO orders (customer_name, phone, comment, total, items_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    String(customer_name).trim(),
    String(phone).trim(),
    String(comment || ""),
    total,
    JSON.stringify(normalized)
  );

  res.json({ success: true, orderId: info.lastInsertRowid });
});

app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY id DESC").all();
  res.json(rows.map(row => ({ ...row, items: JSON.parse(row.items_json) })));
});

app.put("/api/admin/orders/:id/status", requireAdmin, (req, res) => {
  const status = String(req.body.status || "Новый");
  db.prepare("UPDATE orders SET status=? WHERE id=?")
    .run(status, Number(req.params.id));
  res.json({ success: true });
});

app.get("/admin", (_, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Ошибка сервера" });
});

app.listen(PORT, () => {
  console.log(`КЛЕВЕР запущен на порту ${PORT}`);
});
