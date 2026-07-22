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
const PORT = process.env.PORT || 3000;

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

function getTableColumns(tableName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map(column => column.name);
}

function addColumnIfMissing(tableName, columnName, definition) {
  const columns = getTableColumns(tableName);

  if (!columns.includes(columnName)) {
    db.exec(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`
    );

    console.log(
      `База обновлена: добавлено поле ${tableName}.${columnName}`
    );
  }
}

addColumnIfMissing(
  "products",
  "short_description",
  "TEXT DEFAULT ''"
);

addColumnIfMissing(
  "orders",
  "items_json",
  "TEXT NOT NULL DEFAULT '[]'"
);

addColumnIfMissing(
  "orders",
  "status",
  "TEXT NOT NULL DEFAULT 'Новый'"
);

addColumnIfMissing(
  "orders",
  "created_at",
  "TEXT DEFAULT CURRENT_TIMESTAMP"
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret:
      process.env.SESSION_SECRET || "replace-me-in-railway",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
  httpOnly: true,
  sameSite: "lax",
  secure: "auto",
  maxAge: 1000 * 60 * 60 * 12
}
  })
);

app.use("/uploads", express.static(UPLOAD_DIR));
app.use(
  "/assets",
  express.static(path.join(__dirname, "assets"))
);
app.use(express.static(__dirname));

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "clever123";

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "";

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID || "";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || "";
const ORDER_EMAIL = process.env.ORDER_EMAIL || SMTP_USER;

const telegramBot = TELEGRAM_BOT_TOKEN
  ? new TelegramBot(TELEGRAM_BOT_TOKEN, {
      polling: false
    })
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
          servername: SMTP_HOST
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 15000
      })
    : null;

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) {
    return next();
  }

  return res.status(401).json({
    error: "Требуется вход"
  });
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

function getIvanovoDateTime() {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value])
  );

  return (
    `${values.year}-${values.month}-${values.day} ` +
    `${values.hour}:${values.minute}:${values.second}`
  );
}

function formatOrderDate(value) {
  if (!value) {
    return "Дата не указана";
  }

  const match = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/
  );

  if (!match) {
    return String(value);
  }

  const [, year, month, day, hour, minute] = match;

  return `${day}.${month}.${year} в ${hour}:${minute}`;
}

function safeParseItems(itemsJson) {
  try {
    const items = JSON.parse(itemsJson || "[]");

    return Array.isArray(items) ? items : [];
  } catch (error) {
    console.error(
      "Не удалось прочитать состав заказа:",
      error
    );

    return [];
  }
}

function buildTelegramMessage(order) {
  const itemsText = order.items
    .map(
      item =>
        `💐 ${item.name} × ${item.qty} — ` +
        `${formatPrice(item.price * item.qty)}`
    )
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
    order.comment
      ? `💬 ${order.comment}`
      : "💬 Комментарий не указан"
  ].join("\n");
}

function buildEmailHtml(order) {
  const itemsHtml = order.items
    .map(
      item => `
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
    `
    )
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;background:#f6f3ee;padding:24px;">
      <div style="background:#ffffff;border-radius:20px;padding:28px;">

        <h1 style="margin:0 0 8px;color:#35543d;">
          КЛЕВЕР
        </h1>

        <h2 style="margin:0 0 8px;color:#35543d;">
          Новый заказ №${order.id}
        </h2>

        <p style="margin:0 0 24px;color:#777;">
          ${escapeHtml(formatOrderDate(order.created_at))}
        </p>

        <p>
          <strong>Клиент:</strong>
          ${escapeHtml(order.customer_name)}
        </p>

        <p>
          <strong>Телефон:</strong>
          ${escapeHtml(order.phone)}
        </p>

        <p>
          <strong>Комментарий:</strong>
          ${
            order.comment
              ? escapeHtml(order.comment)
              : "Не указан"
          }
        </p>

        <table style="width:100%;border-collapse:collapse;margin-top:22px;">
          <thead>
            <tr>
              <th style="padding:10px;text-align:left;background:#fdf6f8;">
                Товар
              </th>

              <th style="padding:10px;text-align:center;background:#fdf6f8;">
                Количество
              </th>

              <th style="padding:10px;text-align:right;background:#fdf6f8;">
                Сумма
              </th>
            </tr>
          </thead>

          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <p style="font-size:20px;color:#35543d;margin-top:24px;">
          <strong>
            Итого: ${formatPrice(order.total)}
          </strong>
        </p>

      </div>
    </div>
  `;
}

async function sendTelegramNotification(order) {
  if (!telegramBot || !TELEGRAM_CHAT_ID) {
    console.log(
      "Telegram не настроен: уведомление пропущено"
    );

    return;
  }

  await telegramBot.sendMessage(
    TELEGRAM_CHAT_ID,
    buildTelegramMessage(order)
  );

  console.log(
    `Telegram: уведомление о заказе №${order.id} отправлено`
  );
}

async function sendEmailNotification(order) {
  if (!mailTransporter || !ORDER_EMAIL) {
    console.log(
      "Email не настроен: уведомление пропущено"
    );

    return;
  }

  await mailTransporter.sendMail({
    from: `"КЛЕВЕР" <${SMTP_USER}>`,
    to: ORDER_EMAIL,
    subject:
      `Новый заказ №${order.id} на ` +
      `${formatPrice(order.total)}`,
    text: buildTelegramMessage(order),
    html: buildEmailHtml(order)
  });

  console.log(
    `Email: уведомление о заказе №${order.id} отправлено`
  );
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
  destination: (_, __, callback) => {
    callback(null, UPLOAD_DIR);
  },

  filename: (_, file, callback) => {
    const originalExtension = path
      .extname(file.originalname)
      .toLowerCase();

    const safeExtension =
      originalExtension || ".jpg";

    callback(
      null,
      `${Date.now()}-` +
        `${Math.round(Math.random() * 1e9)}` +
        `${safeExtension}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 8 * 1024 * 1024
  },

  fileFilter: (_, file, callback) => {
    if (!file.mimetype.startsWith("image/")) {
      return callback(
        new Error(
          "Можно загружать только изображения"
        )
      );
    }

    callback(null, true);
  }
});

app.get("/api/health", (_, res) => {
  res.json({
    ok: true
  });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};

  if (
    username === ADMIN_USER &&
    password === ADMIN_PASSWORD
  ) {
    req.session.isAdmin = true;

    return res.json({
      success: true
    });
  }

  return res.status(401).json({
    error: "Неверный логин или пароль"
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: "Не удалось выйти"
      });
    }

    res.clearCookie("connect.sid");

    return res.json({
      success: true
    });
  });
});

app.get("/api/me", (req, res) => {
  res.json({
    isAdmin: Boolean(req.session?.isAdmin)
  });
});

app.get("/api/products", (_, res) => {
  const products = db
    .prepare(`
      SELECT
        id,
        name,
        price,
        short_description,
        description,
        image,
        category,
        visible,
        sort_order
      FROM products
      WHERE visible = 1
      ORDER BY sort_order ASC, id DESC
    `)
    .all();

  res.json(products);
});

app.get(
  "/api/admin/products",
  requireAdmin,
  (_, res) => {
    const products = db
      .prepare(`
        SELECT
          id,
          name,
          price,
          short_description,
          description,
          image,
          category,
          visible,
          sort_order,
          created_at
        FROM products
        ORDER BY sort_order ASC, id DESC
      `)
      .all();

    res.json(products);
  }
);

app.post(
  "/api/admin/upload",
  requireAdmin,
  upload.single("image"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "Файл не выбран"
      });
    }

    return res.json({
      url: `/uploads/${req.file.filename}`
    });
  }
);

app.post(
  "/api/admin/products",
  requireAdmin,
  (req, res) => {
    const {
      name,
      price,
      short_description = "",
      description = "",
      image = "",
      category = "Букеты",
      visible = true,
      sort_order = 0
    } = req.body || {};

    if (
      !String(name || "").trim() ||
      Number(price) <= 0
    ) {
      return res.status(400).json({
        error: "Укажите название и цену"
      });
    }

    const result = db
      .prepare(`
        INSERT INTO products
          (
            name,
            price,
            short_description,
            description,
            image,
            category,
            visible,
            sort_order
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        String(name).trim(),
        Math.round(Number(price)),
        String(short_description || "").trim(),
        String(description || "").trim(),
        String(image || "").trim(),
        String(category || "Букеты").trim(),
        visible ? 1 : 0,
        Math.round(Number(sort_order) || 0)
      );

    return res.json({
      success: true,
      id: Number(result.lastInsertRowid)
    });
  }
);

app.put(
  "/api/admin/products/:id",
  requireAdmin,
  (req, res) => {
    const productId = Number(req.params.id);

    const {
      name,
      price,
      short_description = "",
      description = "",
      image = "",
      category = "Букеты",
      visible = true,
      sort_order = 0
    } = req.body || {};

    if (
      !Number.isInteger(productId) ||
      productId <= 0
    ) {
      return res.status(400).json({
        error: "Некорректный номер товара"
      });
    }

    if (
      !String(name || "").trim() ||
      Number(price) <= 0
    ) {
      return res.status(400).json({
        error: "Укажите название и цену"
      });
    }

    const result = db
      .prepare(`
        UPDATE products
        SET
          name = ?,
          price = ?,
          short_description = ?,
          description = ?,
          image = ?,
          category = ?,
          visible = ?,
          sort_order = ?
        WHERE id = ?
      `)
      .run(
        String(name).trim(),
        Math.round(Number(price)),
        String(short_description || "").trim(),
        String(description || "").trim(),
        String(image || "").trim(),
        String(category || "Букеты").trim(),
        visible ? 1 : 0,
        Math.round(Number(sort_order) || 0),
        productId
      );

    if (result.changes === 0) {
      return res.status(404).json({
        error: "Товар не найден"
      });
    }

    return res.json({
      success: true
    });
  }
);

app.delete(
  "/api/admin/products/:id",
  requireAdmin,
  (req, res) => {
    const productId = Number(req.params.id);

    if (
      !Number.isInteger(productId) ||
      productId <= 0
    ) {
      return res.status(400).json({
        error: "Некорректный номер товара"
      });
    }

    const result = db
      .prepare(
        "DELETE FROM products WHERE id = ?"
      )
      .run(productId);

    if (result.changes === 0) {
      return res.status(404).json({
        error: "Товар не найден"
      });
    }

    return res.json({
      success: true
    });
  }
);

app.post("/api/orders", (req, res) => {
  const {
    customer_name,
    phone,
    comment = "",
    items = []
  } = req.body || {};

  const cleanCustomerName = String(
    customer_name || ""
  ).trim();

  const cleanPhone = String(
    phone || ""
  ).trim();

  const cleanComment = String(
    comment || ""
  ).trim();

  if (!cleanCustomerName || !cleanPhone) {
    return res.status(400).json({
      error: "Введите имя и телефон"
    });
  }

  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return res.status(400).json({
      error: "Корзина пуста"
    });
  }

  const normalizedItems = items
    .map(item => ({
      name: String(item.name || "").trim(),

      price: Math.round(
        Number(item.price) || 0
      ),

      qty: Math.max(
        1,
        Math.min(
          99,
          Math.round(
            Number(
              item.qty ?? item.quantity
            ) || 1
          )
        )
      )
    }))
    .filter(
      item =>
        item.name &&
        item.price > 0
    );

  if (normalizedItems.length === 0) {
    return res.status(400).json({
      error:
        "В заказе нет корректных товаров"
    });
  }

  const total = normalizedItems.reduce(
    (sum, item) =>
      sum + item.price * item.qty,
    0
  );

  const createdAt = getIvanovoDateTime();

  const result = db
    .prepare(`
      INSERT INTO orders
        (
          customer_name,
          phone,
          comment,
          total,
          items_json,
          status,
          created_at
        )
      VALUES (?, ?, ?, ?, ?, 'Новый', ?)
    `)
    .run(
      cleanCustomerName,
      cleanPhone,
      cleanComment,
      total,
      JSON.stringify(normalizedItems),
      createdAt
    );

  const order = {
    id: Number(result.lastInsertRowid),
    customer_name: cleanCustomerName,
    phone: cleanPhone,
    comment: cleanComment,
    total,
    items: normalizedItems,
    status: "Новый",
    created_at: createdAt
  };

  sendOrderNotifications(order);

  return res.status(201).json({
    success: true,
    orderId: order.id,
    created_at: order.created_at
  });
});

app.get(
  "/api/admin/orders",
  requireAdmin,
  (_, res) => {
    const rows = db
      .prepare(`
        SELECT
          id,
          customer_name,
          phone,
          comment,
          total,
          items_json,
          status,
          created_at
        FROM orders
        ORDER BY id DESC
      `)
      .all();

    const orders = rows.map(row => ({
      id: row.id,
      customer_name: row.customer_name,
      phone: row.phone,
      comment: row.comment || "",
      total: row.total,
      status: row.status || "Новый",
      created_at: row.created_at,
      created_at_formatted:
        formatOrderDate(row.created_at),
      items: safeParseItems(row.items_json)
    }));

    return res.json(orders);
  }
);

app.put(
  "/api/admin/orders/:id/status",
  requireAdmin,
  (req, res) => {
    const orderId = Number(req.params.id);

    const allowedStatuses = [
      "Новый",
      "Принят",
      "В работе",
      "Готов",
      "Завершён",
      "Отменён"
    ];

    const status = String(
      req.body?.status || ""
    ).trim();

    if (
      !Number.isInteger(orderId) ||
      orderId <= 0
    ) {
      return res.status(400).json({
        error: "Некорректный номер заказа"
      });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: "Некорректный статус заказа"
      });
    }

    const result = db
      .prepare(`
        UPDATE orders
        SET status = ?
        WHERE id = ?
      `)
      .run(status, orderId);

    if (result.changes === 0) {
      return res.status(404).json({
        error: "Заказ не найден"
      });
    }

    return res.json({
      success: true,
      status
    });
  }
);

app.get("/admin", (_, res) => {
  res.sendFile(
    path.join(__dirname, "admin.html")
  );
});

app.use((err, req, res, next) => {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  if (
    err instanceof multer.MulterError &&
    err.code === "LIMIT_FILE_SIZE"
  ) {
    return res.status(400).json({
      error:
        "Файл слишком большой. Максимум 8 МБ"
    });
  }

  return res.status(500).json({
    error:
      err.message || "Ошибка сервера"
  });
});

app.listen(PORT, () => {
  console.log(
    `КЛЕВЕР запущен на порту ${PORT}`
  );

  if (
    telegramBot &&
    TELEGRAM_CHAT_ID
  ) {
    console.log(
      "Telegram-уведомления настроены"
    );
  } else {
    console.log(
      "Telegram-уведомления не настроены"
    );
  }

  if (
    mailTransporter &&
    ORDER_EMAIL
  ) {
    console.log(
      "Email-уведомления настроены"
    );
  } else {
    console.log(
      "Email-уведомления не настроены"
    );
  }
});
