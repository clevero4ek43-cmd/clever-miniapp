const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const PRODUCTS_FILE = path.join(__dirname, "products.json");

function loadProducts() {
  if (!fs.existsSync(PRODUCTS_FILE)) {
    fs.writeFileSync(PRODUCTS_FILE, "[]");
  }
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
}

function saveProducts(products) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
}

app.get("/api/products", (req, res) => {
  res.json(loadProducts());
});

app.post("/api/products", (req, res) => {
  const products = loadProducts();

  const product = {
    id: Date.now(),
    ...req.body
  };

  products.push(product);
  saveProducts(products);

  res.json(product);
});

app.put("/api/products/:id", (req, res) => {
  let products = loadProducts();

  products = products.map(p =>
    p.id == req.params.id ? { ...p, ...req.body } : p
  );

  saveProducts(products);

  res.json({ success: true });
});

app.delete("/api/products/:id", (req, res) => {
  let products = loadProducts();

  products = products.filter(p => p.id != req.params.id);

  saveProducts(products);

  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started on port " + PORT);
});
