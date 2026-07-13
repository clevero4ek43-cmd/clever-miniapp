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
  secret: process.env.SESSION_SECRET || "replace-me-in-railway",
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

const mailTransporter =
  SMTP_HOST && SMTP_USER && SMTP_PASSWORD
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASSWORD
        },
        tls: {
          servername: "smtp.yandex.ru"
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 15000
      })
    : null;

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(401).json({ error: "Требуется вход" });
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

function buildTelegramMessage(order) {
  const itemsText = order.items
    .map(item =>
      `💐 ${item.name} × ${item.qty} — ${formatPrice(item.price * item.qty)}`
    )
    .join("\n");

  return [
    "🌸 КЛЕВЕР",
    "",
    `Новый заказ №${order.id}`,
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
  const itemsHtml = order.items
    .map(item => `
      <tr>
        <td style="padding:10px;border-bottom:1px solid #eee;">
          ${escapeHtml(item.name)}
        </td>
        <td style="padding:10px;border-bottom:1px solid #eee;text-align:center;">
          ${item.qty}
        </td>
        <td style="padding:10px;border-bottom:1px solid #eee;text-align:right;">
          ${formatPrice(item.price * item.qty)}
        </td>
      </tr>
    `)
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;background:#f6f3ee;padding:24px;">
      <div style="background:#ffffff;border-radius:20px;padding:28px;">
        <h1 style="margin:0 0 8px;color:#35543d;">КЛЕВЕР</h1>
        <h2 style="margin:0 0 24px;color:#35543d;">Новый заказ №${order.id}</h2>

        <p><strong>Клиент:</strong> ${escapeHtml(order.customer_name)}</p>
        <p><strong>Телефон:</strong> ${escapeHtml(order.phone)}</p>
        <p><strong>Комментарий:</strong> ${
          order.comment ? escapeHtml(order.comment) : "Не указан"
        }</p>

        <table style="width:100%;border-collapse:collapse;margin-top:22px;">
          <thead>
            <tr>
              <th style="padding:10px;text-align:left;background:#fdf6f8;">Товар</th>
              <th style="padding:10px;text-align:center;background:#fdf6f8;">Количество</th>
              <th style="padding:10px;text-align:right;background:#fdf6f8;">Сумма</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <p style="font-size:20px;color:#35543d;margin-top:24px;">
          <strong>Итого: ${formatPrice(order.total)}</strong>
        </p>
      </div>
    </div>
  `;
}

async function sendTelegramNotification(order) {
  if (!telegramBot || !TELEGRAM_CHAT_ID) {
    console.log("Telegram не настроен: уведомление пропущено");
    return;
  }

  await telegramBot.sendMessage(
    TELEGRAM_CHAT_ID,
    buildTelegramMessage(order)
  );

  console.log(`Telegram: уведомление о заказе №${order.id} отправлено`);
}

async function sendEmailNotification(order) {
  if (!mailTransporter || !ORDER_EMAIL) {
    console.log("Email не настроен: уведомление пропущено");
    return;
  }

  await mailTransporter.sendMail({
    from: `"КЛЕВЕР" <${SMTP_USER}>`,
    to: ORDER_EMAIL,
    subject: `Новый заказ №${order.id} на ${formatPrice(order.total)}`,
    text: buildTelegramMessage(order),
    html: buildEmailHtml(order)
  });

  console.log(`Email: уведомление о заказе №${order.id} отправлено`);
}

function sendOrderNotifications(order) {
  Promise.allSettled([
    sendTelegramNotification(order),
    sendEmailNotification(order)
  ]).then(results => {
    const [telegramResult, emailResult] = results;

    if (telegramResult.status === "rejected") {
      console.error(
        `Ошибка Telegram для заказа №${order.id}:`,
        telegramResult.reason
      );
    }

    if (emailResult.status === "rejected") {
      console.error(
        `Ошибка Email для заказа №${order.id}:`,
        emailResult.reason
      );
    }
  });
}

const storage = multer.diskStorage({
  destination: (_, __, callback) => callback(null, UPLOAD_DIR),
  filename: (_, file, callback) => {
    const safeExtension =
      path.extname(file.originalname).toLowerCase() || ".jpg";

    callback(
      null,
      `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExtension}`
    );
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

app.get("/api/health", (_, res) => {
  res.json({ ok: true });
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

app.get("/api/products", (_, res) => {
  const products = db.prepare(`
    SELECT id, name, price, description, image, category, visible, sort_order
    FROM products
    WHERE visible = 1
    ORDER BY sort_order ASC, id DESC
  `).all();

  res.json(products);
});

app.get("/api/admin/products", requireAdmin, (_, res) => {
  const products = db.prepare(`
    SELECT id, name, price, description, image, category, visible, sort_order, created_at
    FROM products
    ORDER BY sort_order ASC, id DESC
  `).all();

  res.json(products);
});

app.post(
  "/api/admin/upload",
  requireAdmin,
  upload.single("image"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Файл не выбран" });
    }

    res.json({ url: `/uploads/${req.file.filename}` });
  }
);

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

  if (!String(name || "").trim() || Number(price) <= 0) {
    return res.status(400).json({ error: "Укажите название и цену" });
  }

  const result = db.prepare(`
    INSERT INTO products
      (name, price, description, image, category, visible, sort_order)
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

  res.json({ id: result.lastInsertRowid });
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

  if (!String(name || "").trim() || Number(price) <= 0) {
    return res.status(400).json({ error: "Укажите название и цену" });
  }

  db.prepare(`
    UPDATE products
    SET name = ?, price = ?, description = ?, image = ?, category = ?, visible = ?, sort_order = ?
    WHERE id = ?
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
  db.prepare("DELETE FROM products WHERE id = ?")
    .run(Number(req.params.id));

  res.json({ success: true });
});

app.post("/api/orders", (req, res) => {
  const {
    customer_name,
    phone,
    comment = "",
    items = []
  } = req.body || {};

  if (
    !String(customer_name || "").trim() ||
    !String(phone || "").trim()
  ) {
    return res.status(400).json({
      error: "Введите имя и телефон"
    });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Корзина пуста" });
  }

  const normalizedItems = items
    .map(item => ({
      name: String(item.name || ""),
      price: Math.round(Number(item.price) || 0),
      qty: Math.max(1, Math.round(Number(item.qty) || 1))
    }))
    .filter(item => item.name && item.price > 0);

  if (normalizedItems.length === 0) {
    return res.status(400).json({
      error: "В заказе нет корректных товаров"
    });
  }

  const total = normalizedItems.reduce(
    (sum, item) => sum + item.price * item.qty,
    0
  );

  const cleanCustomerName = String(customer_name).trim();
  const cleanPhone = String(phone).trim();
  const cleanComment = String(comment || "").trim();

  const result = db.prepare(`
    INSERT INTO orders
      (customer_name, phone, comment, total, items_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    cleanCustomerName,
    cleanPhone,
    cleanComment,
    total,
    JSON.stringify(normalizedItems)
  );

  const order = {
    id: Number(result.lastInsertRowid),
    customer_name: cleanCustomerName,
    phone: cleanPhone,
    comment: cleanComment,
    total,
    items: normalizedItems
  };

  sendOrderNotifications(order);

  res.json({
    success: true,
    orderId: order.id
  });
});

app.get("/api/admin/orders", requireAdmin, (_, res) => {
  const rows = db.prepare(`
    SELECT id, customer_name, phone, comment, total, items_json, status, created_at
    FROM orders
    ORDER BY id DESC
  `).all();

  res.json(
    rows.map(row => ({
      ...row,
      items: JSON.parse(row.items_json)
    }))
  );
});

app.put(
  "/api/admin/orders/:id/status",
  requireAdmin,
  (req, res) => {
    const status = String(req.body?.status || "Новый");

    db.prepare(`
      UPDATE orders
      SET status = ?
      WHERE id = ?
    `).run(status, Number(req.params.id));

    res.json({ success: true });
  }
);

app.get("/admin", (_, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: err.message || "Ошибка сервера"
  });
});

app.listen(PORT, () => {
  console.log(`КЛЕВЕР запущен на порту ${PORT}`);

  if (telegramBot && TELEGRAM_CHAT_ID) {
    console.log("Telegram-уведомления настроены");
  } else {
    console.log("Telegram-уведомления не настроены");
  }

  if (mailTransporter && ORDER_EMAIL) {
    console.log("Email-уведомления настроены");
  } else {
    console.log("Email-уведомления не настроены");
  }
});
