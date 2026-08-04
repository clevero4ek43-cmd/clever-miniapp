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

CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  image TEXT NOT NULL,
  is_main INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  zoom REAL NOT NULL DEFAULT 1,
  pos_x REAL NOT NULL DEFAULT 0,
  pos_y REAL NOT NULL DEFAULT 0,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
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
addColumnIfMissing(
  "orders",
  "delivery_method",
  "TEXT NOT NULL DEFAULT 'pickup'"
);

addColumnIfMissing(
  "orders",
  "delivery_address",
  "TEXT DEFAULT ''"
);

addColumnIfMissing(
  "orders",
  "recipient_name",
  "TEXT DEFAULT ''"
);

addColumnIfMissing(
  "orders",
  "recipient_phone",
  "TEXT DEFAULT ''"
);

addColumnIfMissing(
  "orders",
  "card_needed",
  "TEXT NOT NULL DEFAULT 'no'"
);

addColumnIfMissing(
  "orders",
  "card_text",
  "TEXT DEFAULT ''"
);
addColumnIfMissing(
  "orders",
  "delivery_date",
  "TEXT DEFAULT ''"
);

addColumnIfMissing(
  "orders",
  "delivery_time",
  "TEXT DEFAULT ''"
);

addColumnIfMissing(
  "orders",
  "recipient_type",
  "TEXT DEFAULT 'self'"
);

db.prepare(`
  INSERT INTO product_images (
    product_id,
    image,
    is_main,
    sort_order,
    zoom,
    pos_x,
    pos_y
  )
  SELECT id, image, 1, 0, 1, 0, 0
  FROM products
  WHERE TRIM(COALESCE(image, '')) <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM product_images
      WHERE product_images.product_id = products.id
    )
`).run();

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
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: "Требуется вход" });
}

function cleanText(value, maxLength = 2000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);

  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, number))
    : fallback;
}

function normalizeProductImages(value, legacyImage = "") {
  const source = Array.isArray(value) ? value : [];
  const images = [];
  const seen = new Set();

  source.slice(0, 5).forEach((item, index) => {
    const image = cleanText(item?.image, 1000);

    if (!image || seen.has(image)) return;

    seen.add(image);

    images.push({
      image,
      is_main: item?.is_main ? 1 : 0,
      sort_order: index,
      zoom: clampNumber(item?.zoom, 1, 2.5, 1),
      pos_x: clampNumber(item?.pos_x, -50, 50, 0),
      pos_y: clampNumber(item?.pos_y, -50, 50, 0)
    });
  });
    const fallbackImage = cleanText(legacyImage, 1000);

  if (!images.length && fallbackImage) {
    images.push({
      image: fallbackImage,
      is_main: 1,
      sort_order: 0,
      zoom: 1,
      pos_x: 0,
      pos_y: 0
    });
  }

  if (images.length) {
    let mainIndex = images.findIndex(item => item.is_main);

    if (mainIndex < 0) mainIndex = 0;

    images.forEach((item, index) => {
      item.is_main = index === mainIndex ? 1 : 0;
      item.sort_order = index;
    });
  }

  return images;
}

function attachImages(products) {
  if (!products.length) return products;

  const ids = products.map(product => Number(product.id));
  const placeholders = ids.map(() => "?").join(",");

  const rows = db.prepare(`
    SELECT id, product_id, image, is_main, sort_order, zoom, pos_x, pos_y
    FROM product_images
    WHERE product_id IN (${placeholders})
    ORDER BY product_id, is_main DESC, sort_order ASC, id ASC
  `).all(...ids);

  const grouped = new Map();

  rows.forEach(row => {
    const list = grouped.get(Number(row.product_id)) || [];

    list.push({
      id: Number(row.id),
      image: row.image,
      is_main: Boolean(row.is_main),
      sort_order: Number(row.sort_order) || 0,
      zoom: Number(row.zoom) || 1,
      pos_x: Number(row.pos_x) || 0,
      pos_y: Number(row.pos_y) || 0
    });

    grouped.set(Number(row.product_id), list);
  });

  return products.map(product => {
    const images = grouped.get(Number(product.id)) || [];
    const main = images.find(item => item.is_main) || images[0];

    return {
      ...product,
      image: main?.image || product.image || "",
      images
    };
  });
}

function replaceProductImages(productId, images) {
  db.prepare(
    "DELETE FROM product_images WHERE product_id = ?"
  ).run(productId);

  const insert = db.prepare(`
    INSERT INTO product_images
      (product_id, image, is_main, sort_order, zoom, pos_x, pos_y)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  images.forEach(item => {
    insert.run(
      productId,
      item.image,
      item.is_main,
      item.sort_order,
      item.zoom,
      item.pos_x,
      item.pos_y
    );
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

function formatOrderDate(value) {
  const match = String(value || "").match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/
  );

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
    .map(item =>
      `💐 ${item.name} × ${item.qty} — ${formatPrice(item.price * item.qty)}`
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
    `🚚 Получение: ${
  order.delivery_method === "delivery"
    ? "Доставка"
    : "Самовывоз"
}`,

order.delivery_method === "delivery"
  ? `📍 Адрес: ${order.delivery_address || "Не указан"}`
  : "",

order.delivery_method === "delivery"
  ? `👤 Получатель: ${order.recipient_name || "Не указан"}`
  : "",

order.delivery_method === "delivery"
  ? `📞 Телефон получателя: ${order.recipient_phone || "Не указан"}`
  : "",

`💌 Открытка: ${
  order.card_needed === "yes" ? "Да" : "Нет"
}`,

order.card_needed === "yes"
  ? `✍️ Текст открытки: ${order.card_text || "Не указан"}`
  : "",    "",
    itemsText,
    "",
    `💰 Итого: ${formatPrice(order.total)}`,
    order.comment
      ? `💬 ${order.comment}`
      : "💬 Комментарий не указан"
  ].join("\n");
}

function buildEmailHtml(order) {
  const rows = order.items.map(item => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #eee">
        ${escapeHtml(item.name)}
      </td>

      <td style="padding:10px;border-bottom:1px solid #eee;text-align:center">
        ${item.qty}
      </td>

      <td style="padding:10px;border-bottom:1px solid #eee;text-align:right">
        ${formatPrice(item.price * item.qty)}
      </td>
    </tr>
  `).join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:650px;margin:auto;background:#f6f3ee;padding:24px">
      <div style="background:#fff;border-radius:20px;padding:28px">
        <h1 style="color:#35543d;margin:0 0 8px">КЛЕВЕР</h1>

        <h2 style="color:#35543d;margin:0 0 8px">
          Новый заказ №${order.id}
        </h2>

        <p style="color:#777;margin-top:0">
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
          ${order.comment
            ? escapeHtml(order.comment)
            : "Не указан"}
        </p>

        <table style="width:100%;border-collapse:collapse;margin-top:20px">
          <thead>
            <tr>
              <th style="padding:10px;text-align:left;background:#fdf6f8">
                Товар
              </th>

              <th style="padding:10px;text-align:center;background:#fdf6f8">
                Количество
              </th>

              <th style="padding:10px;text-align:right;background:#fdf6f8">
                Сумма
              </th>
            </tr>
          </thead>

          <tbody>${rows}</tbody>
        </table>

        <p style="font-size:20px;color:#35543d">
          <strong>Итого: ${formatPrice(order.total)}</strong>
        </p>
      </div>
    </div>
  `;
}

async function sendTelegramNotification(order) {
  if (!telegramBot || !TELEGRAM_CHAT_ID) return;

  await telegramBot.sendMessage(
    TELEGRAM_CHAT_ID,
    buildTelegramMessage(order)
  );
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
        console.error(
          index === 0 ? "Ошибка Telegram:" : "Ошибка Email:",
          result.reason
        );
      }
    });
  });
}

const storage = multer.diskStorage({
  destination: (_, __, callback) => callback(null, UPLOAD_DIR),

  filename: (_, file, callback) => {
    const extension =
      path.extname(file.originalname).toLowerCase() || ".jpg";

    callback(
      null,
      `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
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
        new Error("Можно загружать только изображения")
      );
    }

    callback(null, true);
  }
});

app.get("/api/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/api/login", (req, res, next) => {
  const username = cleanText(req.body?.username, 100);
  const password = String(req.body?.password || "");

  if (
    username !== ADMIN_USER ||
    password !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: "Неверный логин или пароль"
    });
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
  res.json({
    isAdmin: Boolean(req.session?.isAdmin)
  });
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

  res.json(attachImages(products));
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
      created_at
    FROM products
    ORDER BY sort_order ASC, id DESC
  `).all();

  res.json(attachImages(products));
});

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

    res.json({
      url: `/uploads/${req.file.filename}`
    });
  }
);

app.post("/api/admin/products", requireAdmin, (req, res) => {
  const name = cleanText(req.body?.name, 200);
  const price = Math.round(Number(req.body?.price));

  const shortDescription = cleanText(
    req.body?.short_description,
    500
  );

  const description = cleanText(
    req.body?.description,
    5000
  );

  const composition = cleanText(
    req.body?.composition,
    5000
  );

  const size = cleanText(req.body?.size, 1000);
  const care = cleanText(req.body?.care, 5000);

  const images = normalizeProductImages(
    req.body?.images,
    req.body?.image
  );

  const image =
    images.find(item => item.is_main)?.image ||
    images[0]?.image ||
    "";

  const category = cleanText(
    req.body?.category || "Букеты",
    100
  );

  const visible = req.body?.visible ? 1 : 0;
  const sortOrder = Math.round(
    Number(req.body?.sort_order) || 0
  );

  if (
    !name ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return res.status(400).json({
      error: "Укажите название и цену"
    });
  }

  const createProduct = db.transaction(() => {
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

    const productId = Number(result.lastInsertRowid);

    replaceProductImages(productId, images);

    return productId;
  });

  const id = createProduct();

  res.status(201).json({
    success: true,
    id
  });
});

app.put(
  "/api/admin/products/:id",
  requireAdmin,
  (req, res) => {
    const id = Number(req.params.id);
    const name = cleanText(req.body?.name, 200);
    const price = Math.round(Number(req.body?.price));

    const shortDescription = cleanText(
      req.body?.short_description,
      500
    );

    const description = cleanText(
      req.body?.description,
      5000
    );

    const composition = cleanText(
      req.body?.composition,
      5000
    );

    const size = cleanText(req.body?.size, 1000);
    const care = cleanText(req.body?.care, 5000);

    const images = normalizeProductImages(
      req.body?.images,
      req.body?.image
    );

    const image =
      images.find(item => item.is_main)?.image ||
      images[0]?.image ||
      "";

    const category = cleanText(
      req.body?.category || "Букеты",
      100
    );

    const visible = req.body?.visible ? 1 : 0;

    const sortOrder = Math.round(
      Number(req.body?.sort_order) || 0
    );

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        error: "Некорректный товар"
      });
    }

    if (
      !name ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return res.status(400).json({
        error: "Укажите название и цену"
      });
    }

    const updateProduct = db.transaction(() => {
      const result = db.prepare(`
        UPDATE products
        SET
          name = ?,
          price = ?,
          short_description = ?,
          description = ?,
          composition = ?,
          size = ?,
          care = ?,
          image = ?,
          category = ?,
          visible = ?,
          sort_order = ?
        WHERE id = ?
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

      if (!result.changes) return false;

      replaceProductImages(id, images);

      return true;
    });

    if (!updateProduct()) {
      return res.status(404).json({
        error: "Товар не найден"
      });
    }

    res.json({ success: true });
  }
);
app.delete("/api/admin/products/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      error: "Некорректный товар"
    });
  }

  const productImages = db.prepare(`
    SELECT image
    FROM product_images
    WHERE product_id = ?

    UNION

    SELECT image
    FROM products
    WHERE id = ?
  `).all(id, id);

  const result = db.prepare(
    "DELETE FROM products WHERE id = ?"
  ).run(id);

  if (!result.changes) {
    return res.status(404).json({
      error: "Товар не найден"
    });
  }

  productImages.forEach(item => {
    if (!item?.image?.startsWith("/uploads/")) return;

    const filePath = path.join(
      UPLOAD_DIR,
      path.basename(item.image)
    );

    fs.unlink(filePath, () => {});
  });

  res.json({ success: true });
});

app.post("/api/orders", (req, res) => {
  const customerName = cleanText(
    req.body?.customer_name,
    200
  );

  const phone = cleanText(req.body?.phone, 100);
  const comment = cleanText(req.body?.comment, 2000);
  const items = req.body?.items;
  const deliveryDate = cleanText(req.body?.delivery_date, 20);
const deliveryTime = cleanText(req.body?.delivery_time, 30);
const recipientType = cleanText(req.body?.recipient_type, 20);

  if (!customerName || !phone) {
    return res.status(400).json({
      error: "Введите имя и телефон"
    });
  }

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({
      error: "Корзина пуста"
    });
  }

  const productIds = [
    ...new Set(
      items
        .map(item => Number(item.id))
        .filter(id => Number.isInteger(id) && id > 0)
    )
  ];

  if (!productIds.length) {
    return res.status(400).json({
      error: "В заказе нет корректных товаров"
    });
  }

  const placeholders = productIds
    .map(() => "?")
    .join(",");

  const actualProducts = db.prepare(`
    SELECT id, name, price
    FROM products
    WHERE id IN (${placeholders})
      AND visible = 1
  `).all(...productIds);

  const productMap = new Map(
    actualProducts.map(product => [
      Number(product.id),
      product
    ])
  );

  const normalizedItems = items
    .map(item => {
      const product = productMap.get(Number(item.id));

      if (!product) return null;

      return {
        id: Number(product.id),
        name: product.name,
        price: Number(product.price),
        qty: Math.max(
          1,
          Math.min(
            99,
            Math.round(
              Number(item.qty ?? item.quantity) || 1
            )
          )
        )
      };
    })
    .filter(Boolean);

  if (!normalizedItems.length) {
    return res.status(400).json({
      error:
        "Товары из корзины больше недоступны. Обновите страницу."
    });
  }

  const total = normalizedItems.reduce(
    (sum, item) => sum + item.price * item.qty,
    0
  );

  const createdAt = db.prepare(`
    SELECT datetime('now', '+3 hours') AS value
  `).get().value;
  const deliveryMethod =
  req.body?.delivery_method === "delivery"
    ? "delivery"
    : "pickup";

const deliveryAddress =
  String(req.body?.delivery_address || "").trim();

const recipientName =
  String(req.body?.recipient_name || "").trim();

const recipientPhone =
  String(req.body?.recipient_phone || "").trim();

const cardNeeded =
  req.body?.card_needed === "yes"
    ? "yes"
    : "no";

const cardText =
  String(req.body?.card_text || "").trim();

if (
  deliveryMethod === "delivery" &&
  (!deliveryAddress || !recipientName || !recipientPhone)
) {
  return res.status(400).json({
    error: "Укажите адрес, имя и телефон получателя"
  });
}

if (cardNeeded === "yes" && !cardText) {
  return res.status(400).json({
    error: "Укажите текст для открытки"
  });
}
  const result = db.prepare(`
  INSERT INTO orders (
    customer_name,
    phone,
    comment,
    delivery_method,
    delivery_date,
    delivery_time,
    recipient_type,
    delivery_address,
    recipient_name,
    recipient_phone,
    card_needed,
    card_text,
    total,
    items_json,
    status,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  customerName,
  phone,
  comment,
  deliveryMethod,
    deliveryDate,
deliveryTime,
recipientType,
    deliveryAddress,
  recipientName,
  recipientPhone,
  cardNeeded,
  cardText,
  total,
  JSON.stringify(normalizedItems),
  "Новый",
  createdAt
);  
  const order = {
    id: Number(result.lastInsertRowid),
    customer_name: customerName,
    phone,
    comment,
    delivery_method: deliveryMethod,
    delivery_date: deliveryDate,
delivery_time: deliveryTime,
recipient_type: recipientType,
delivery_address: deliveryAddress,
recipient_name: recipientName,
recipient_phone: recipientPhone,
card_needed: cardNeeded,
card_text: cardText,    total,
    items: normalizedItems,
    status: "Новый",
    created_at: createdAt
  };

  sendOrderNotifications(order);

  res.status(201).json({
    success: true,
    orderId: order.id,
    created_at: createdAt
  });
});

app.get("/api/admin/orders", requireAdmin, (_, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      customer_name,
      phone,
      comment,
      delivery_method,
delivery_address,
recipient_name,
recipient_phone,
card_needed,
card_text,      total,
      items_json,
      status,
      created_at
    FROM orders
    ORDER BY id DESC
  `).all();

  res.json(
    rows.map(row => ({
      id: row.id,
      customer_name: row.customer_name,
      phone: row.phone,
      comment: row.comment || "",
      delivery_method: row.delivery_method || "pickup",
delivery_address: row.delivery_address || "",
recipient_name: row.recipient_name || "",
recipient_phone: row.recipient_phone || "",
card_needed: row.card_needed || "no",
card_text: row.card_text || "",
      total: row.total,
      status: row.status || "Новый",
      created_at: row.created_at,
      created_at_formatted: formatOrderDate(
        row.created_at
      ),
      items: parseItems(row.items_json)
    }))
  );
});

app.put(
  "/api/admin/orders/:id/status",
  requireAdmin,
  (req, res) => {
    const id = Number(req.params.id);
    const status = cleanText(req.body?.status, 50);

    const allowed = [
      "Новый",
      "Принят",
      "В работе",
      "Готов",
      "Доставлен",
      "Завершён",
      "Отменён"
    ];

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        error: "Некорректный заказ"
      });
    }

    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: "Некорректный статус"
      });
    }

    
    const result = db.prepare(`
      UPDATE orders
      SET status = ?
      WHERE id = ?
    `).run(status, id);

    if (!result.changes) {
      return res.status(404).json({
        error: "Заказ не найден"
      });
    }

    res.json({
      success: true,
      status
    });
  }
);
app.delete(
  "/api/admin/orders/:id",
  requireAdmin,
  (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        error: "Некорректный заказ"
      });
    }

    const result = db.prepare(`
      DELETE FROM orders
      WHERE id = ?
    `).run(id);

    if (!result.changes) {
      return res.status(404).json({
        error: "Заказ не найден"
      });
    }

    res.json({
      success: true
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
      error: "Файл слишком большой. Максимум 8 МБ"
    });
  }

  res.status(500).json({
    error: err.message || "Ошибка сервера"
  });
});

app.listen(PORT, () => {
  console.log(`КЛЕВЕР запущен на порту ${PORT}`);

  console.log(
    telegramBot && TELEGRAM_CHAT_ID
      ? "Telegram-уведомления настроены"
      : "Telegram-уведомления не настроены"
  );

  console.log(
    mailTransporter && ORDER_EMAIL
      ? "Email-уведомления настроены"
      : "Email-уведомления не настроены"
  );
});
