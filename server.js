const express = require("express");
const session = require("express-session");
const multer = require("multer");
const Database = require("better-sqlite3");
const TelegramBot = require("node-telegram-bot-api");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "clever.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  short_description TEXT DEFAULT '',
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
  items_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'Новый',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function getColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map(row => row.name);
}

function addColumnIfMissing(tableName, columnName, definition) {
  if (!getColumns(tableName).includes(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    console.log(`Добавлен столбец ${tableName}.${columnName}`);
  }
}

addColumnIfMissing("products", "short_description", "TEXT DEFAULT ''");
addColumnIfMissing("products", "composition", "TEXT DEFAULT ''");
addColumnIfMissing("products", "size", "TEXT DEFAULT ''");
addColumnIfMissing("products", "care", "TEXT DEFAULT ''");
addColumnIfMissing("orders", "items_json", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("orders", "status", "TEXT NOT NULL DEFAULT 'Новый'");
addColumnIfMissing("orders", "created_at", "TEXT DEFAULT ''");

db.prepare(`
  UPDATE orders
  SET created_at = datetime('now', '+3 hours')
   WHERE created_at IS NULL OR TRIM(created_at) = ''
`).run();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || "replace-this-secret-in-railway",
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: "auto",
    maxAge: 1000 * 60 * 60 * 12
  }
}));

app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use(express.static(__dirname));

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "clever123";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || "";
const ORDER_EMAIL = process.env.ORDER_EMAIL || SMTP_USER;

const telegramBot = TELEGRAM_BOT_TOKEN
  ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false })
  : null;

const mailTransporter = SMTP_HOST && SMTP_USER && SMTP_PASSWORD
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      tls: { servername: SMTP_HOST },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000
    })
  : null;

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: "Требуется вход" });
}

function cleanText(value, maxLength = 2000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function formatPrice(value) {
  return `${Number(value || 0).toLocaleString("ru-RU")} ₽`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  }

function formatOrderDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return String(value || "Дата не указана");
  return `${match[3]}.${match[2]}.${match[1]} в ${match[4]}:${match[5]}`;
}

function parseItems(itemsJson) {
  try {
    const items = JSON.parse(itemsJson || "[]");
    return Array.isArray(items) ? items : [];
  } catch (error) {
    console.error("Ошибка чтения состава заказа:", error);
    return [];
  }
}

function buildTelegramMessage(order) {
  const itemsText = order.items
    .map(item => `💐 ${item.name} × ${item.qty} — ${formatPrice(item.price * item.qty)}`)
    .join("\n");

  return [
    "🌸 КЛЕВЕР",
    "",
    `Новый заказ №${order.id}`,
    `🕒 ${formatOrderDate(order.created_at)}`,
    "",
    `👤 ${order.customer_name}`,
    `📞 ${order.phone}`,
    "",
    itemsText,
    "",
    `💰 Итого: ${formatPrice(order.total)}`,
    order.comment ? `💬 ${order.comment}` : "💬 Комментарий не указан"
  ].join("\n");
}

function buildEmailHtml(order) {
  const rows = order.items.map(item => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #eee">${escapeHtml(item.name)}</td>
      <td style="padding:10px;border-bottom:1px solid #eee;text-align:center">${item.qty}</td>
      <td style="padding:10px;border-bottom:1px solid #eee;text-align:right">${formatPrice(item.price * item.qty)}</td>
    </tr>
  `).join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:650px;margin:auto;background:#f6f3ee;padding:24px">
      <div style="background:#fff;border-radius:20px;padding:28px">
        <h1 style="color:#35543d;margin:0 0 8px">КЛЕВЕР</h1>
        <h2 style="color:#35543d;margin:0 0 8px">Новый заказ №${order.id}</h2>
        <p style="color:#777;margin-top:0">${escapeHtml(formatOrderDate(order.created_at))}</p>
        <p><strong>Клиент:</strong> ${escapeHtml(order.customer_name)}</p>
        <p><strong>Телефон:</strong> ${escapeHtml(order.phone)}</p>
        <p><strong>Комментарий:</strong> ${order.comment ? escapeHtml(order.comment) : "Не указан"}</p>
        <table style="width:100%;border-collapse:collapse;margin-top:20px">
          <thead><tr>
            <th style="padding:10px;text-align:left;background:#fdf6f8">Товар</th>
            <th style="padding:10px;text-align:center;background:#fdf6f8">Количество</th>
            <th style="padding:10px;text-align:right;background:#fdf6f8">Сумма</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="font-size:20px;color:#35543d"><strong>Итого: ${formatPrice(order.total)}</strong></p>
      </div>
    </div>
  `;
}
async function sendTelegramNotification(order) {
  if (!telegramBot || !TELEGRAM_CHAT_ID) return;
  await telegramBot.sendMessage(TELEGRAM_CHAT_ID, buildTelegramMessage(order));
}

async function sendEmailNotification(order) {
  if (!mailTransporter || !ORDER_EMAIL) return;
  await mailTransporter.sendMail({
    from: `"КЛЕВЕР" <${SMTP_USER}>`,
    to: ORDER_EMAIL,
    subject: `Новый заказ №${order.id} на ${formatPrice(order.total)}`,
    text: buildTelegramMessage(order),
    html: buildEmailHtml(order)
  });
}

function sendOrderNotifications(order) {
  Promise.allSettled([
    sendTelegramNotification(order),
    sendEmailNotification(order)
  ]).then(results => {
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(index === 0 ? "Ошибка Telegram:" : "Ошибка Email:", result.reason);
      }
    });
  });
}

const storage = multer.diskStorage({
  destination: (_, __, callback) => callback(null, UPLOAD_DIR),
  filename: (_, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase() || ".jpg";
    callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_, file, callback) => {
    if (!file.mimetype.startsWith("image/")) {
      return callback(new Error("Можно загружать только изображения"));
    }
    callback(null, true);
  }
});

app.get("/api/health", (_, res) => res.json({ ok: true }));

app.post("/api/login", (req, res, next) => {
  const username = cleanText(req.body?.username, 100);
  const password = String(req.body?.password || "");

  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }

  req.session.regenerate(error => {
    if (error) return next(error);
    req.session.isAdmin = true;
    req.session.save(saveError => {
      if (saveError) return next(saveError);
      res.json({ success: true });
    });
  });
});

app.post("/api/logout", (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({ isAdmin: Boolean(req.session?.isAdmin) });
});

app.get("/api/products", (_, res) => {
  const products = db.prepare(`
   SELECT
  id,
  name,
  price,
  short_description,
  description,
  composition,
  size,
  care,
  image,
  category,
  visible,
  sort_order
    FROM products
    WHERE visible = 1
    ORDER BY sort_order ASC, id DESC
  `).all();
  res.json(products);
});

app.get("/api/admin/products", requireAdmin, (_, res) => {
  const products = db.prepare(`
   SELECT
  id,
  name,
  price,
  short_description,
  description,
  composition,
  size,
  care,
  image,
  category,
  visible,
  sort_order,
  created_at    FROM products
    ORDER BY sort_order ASC, id DESC
  `).all();
  res.json(products);
});

app.post("/api/admin/upload", requireAdmin, upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не выбран" });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.post("/api/admin/products", requireAdmin, (req, res) => {
  const name = cleanText(req.body?.name, 200);
  const price = Math.round(Number(req.body?.price));
  const shortDescription = cleanText(req.body?.short_description, 500);
  const description = cleanText(req.body?.description, 5000);
  const composition = cleanText(req.body?.composition, 5000);
const size = cleanText(req.body?.size, 1000);
const care = cleanText(req.body?.care, 5000);
  const image = cleanText(req.body?.image, 1000);
  const category = cleanText(req.body?.category || "Букеты", 100);
  const visible = req.body?.visible ? 1 : 0;
  const sortOrder = Math.round(Number(req.body?.sort_order) || 0);

  if (!name || !Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: "Укажите название и цену" });
  }

  const result = db.prepare(`
    INSERT INTO products (
  name,
  price,
  short_description,
  description,
  composition,
  size,
  care,
  image,
  category,
  visible,
  sort_order
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
`).run(
  name,
  price,
  shortDescription,
  description,
  composition,
  size,
  care,
  image,
  category,
  visible,
  sortOrder
);

  res.status(201).json({ success: true, id: Number(result.lastInsertRowid) });
});

app.put("/api/admin/products/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const name = cleanText(req.body?.name, 200);
  const price = Math.round(Number(req.body?.price));
  const shortDescription = cleanText(req.body?.short_description, 500);
  const description = cleanText(req.body?.description, 5000);
  const composition = cleanText(req.body?.composition, 5000);
const size = cleanText(req.body?.size, 1000);
const care = cleanText(req.body?.care, 5000);
  const image = cleanText(req.body?.image, 1000);
  const category = cleanText(req.body?.category || "Букеты", 100);
  const visible = req.body?.visible ? 1 : 0;
  const sortOrder = Math.round(Number(req.body?.sort_order) || 0);

  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Некорректный товар" });
  if (!name || !Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: "Укажите название и цену" });
  }

  const result = db.prepare(`
   UPDATE products
SET
  name=?,
  price=?,
  short_description=?,
  description=?,
  composition=?,
  size=?,
  care=?,
  image=?,
  category=?,
  visible=?,
  sort_order=?
WHERE id=?
`).run(
  name,
  price,
  shortDescription,
  description,
  composition,
  size,
  care,
  image,
  category,
  visible,
  sortOrder,
  id
);

  if (!result.changes) return res.status(404).json({ error: "Товар не найден" });
  res.json({ success: true });
});

app.delete("/api/admin/products/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Некорректный товар" });

  const product = db.prepare("SELECT image FROM products WHERE id = ?").get(id);
  const result = db.prepare("DELETE FROM products WHERE id = ?").run(id);
  if (!result.changes) return res.status(404).json({ error: "Товар не найден" });

  if (product?.image?.startsWith("/uploads/")) {
    const filePath = path.join(UPLOAD_DIR, path.basename(product.image));
    fs.unlink(filePath, () => {});
  }

  res.json({ success: true });
});

app.post("/api/orders", (req, res) => {
  const customerName = cleanText(req.body?.customer_name, 200);
  const phone = cleanText(req.body?.phone, 100);
  const comment = cleanText(req.body?.comment, 2000);
  const items = req.body?.items;

  if (!customerName || !phone) return res.status(400).json({ error: "Введите имя и телефон" });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Корзина пуста" });

  const productIds = [...new Set(items.map(item => Number(item.id)).filter(id => Number.isInteger(id) && id > 0))];
  if (!productIds.length) return res.status(400).json({ error: "В заказе нет корректных товаров" });

  const placeholders = productIds.map(() => "?").join(",");
  const actualProducts = db.prepare(`
    SELECT id, name, price
    FROM products
    WHERE id IN (${placeholders}) AND visible = 1
  `).all(...productIds);
  const productMap = new Map(actualProducts.map(product => [Number(product.id), product]));

  const normalizedItems = items.map(item => {
    const product = productMap.get(Number(item.id));
    if (!product) return null;
    return {
      id: Number(product.id),
      name: product.name,
      price: Number(product.price),
      qty: Math.max(1, Math.min(99, Math.round(Number(item.qty ?? item.quantity) || 1)))
    };
  }).filter(Boolean);

  if (!normalizedItems.length) {
    return res.status(400).json({ error: "Товары из корзины больше недоступны. Обновите страницу." });
  }

  const total = normalizedItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  const createdAt = db.prepare("SELECT datetime('now', '+3 hours') AS value").get().value;

  const result = db.prepare(`
    INSERT INTO orders (customer_name, phone, comment, total, items_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'Новый', ?)
     `).run(customerName, phone, comment, total, JSON.stringify(normalizedItems), createdAt);

  const order = {
    id: Number(result.lastInsertRowid),
    customer_name: customerName,
    phone,
    comment,
    total,
    items: normalizedItems,
    status: "Новый",
    created_at: createdAt
  };

  sendOrderNotifications(order);
  res.status(201).json({ success: true, orderId: order.id, created_at: createdAt });
});

app.get("/api/admin/orders", requireAdmin, (_, res) => {
  const rows = db.prepare(`
    SELECT id, customer_name, phone, comment, total, items_json, status, created_at
    FROM orders
    ORDER BY id DESC
  `).all();

  res.json(rows.map(row => ({
    id: row.id,
    customer_name: row.customer_name,
    phone: row.phone,
    comment: row.comment || "",
    total: row.total,
    status: row.status || "Новый",
    created_at: row.created_at,
    created_at_formatted: formatOrderDate(row.created_at),
    items: parseItems(row.items_json)
  })));
});

app.put("/api/admin/orders/:id/status", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = cleanText(req.body?.status, 50);
  const allowed = ["Новый", "Принят", "В работе", "Готов", "Доставлен", "Завершён", "Отменён"];

  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Некорректный заказ" });
  if (!allowed.includes(status)) return res.status(400).json({ error: "Некорректный статус" });

  const result = db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, id);
  if (!result.changes) return res.status(404).json({ error: "Заказ не найден" });
  res.json({ success: true, status });
});

app.get("/admin", (_, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "Файл слишком большой. Максимум 8 МБ" });
  }

  res.status(500).json({ error: err.message || "Ошибка сервера" });
});

app.listen(PORT, () => {
  console.log(`КЛЕВЕР запущен на порту ${PORT}`);
  console.log(telegramBot && TELEGRAM_CHAT_ID ? "Telegram-уведомления настроены" : "Telegram-уведомления не настроены");
  console.log(mailTransporter && ORDER_EMAIL ? "Email-уведомления настроены" : "Email-уведомления не настроены");
});
