import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { ProductType } from "../models/types";
import { adjustWarehouseStock } from "../utils/warehouseStock";

/**
 * "Produk" -- Barang & Jasa tab only for now (Gudang/warehouse are deferred, and the
 * Aturan Harga tab was dropped entirely -- not needed). Stock is a plain manual
 * number on the row, not a computed warehouse ledger. A product can independently be
 * something bought ("Saya beli produk ini"), sold ("Saya jual produk ini"), or both --
 * each side links to its own account/tax, matching Mekari's own "Tambah produk baru"
 * form, for future auto-posting when a real purchase/sale transaction references it.
 * "Tipe Produk" (Single/Bundle) is a separate dimension from Barang/Jasa; a Bundle
 * additionally holds a list of qty-tracked Single products as its components (see
 * product_bundle_components) -- composition only, no auto-posting or stock
 * decrementing on sale yet.
 */

const PRODUCT_TYPES: ProductType[] = ["barang", "jasa"];

function mapRow(row: any) {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    type: row.type,
    name: row.name,
    code: row.code,
    barcode: row.barcode,
    categoryId: row.category_id,
    categoryName: row.category_name,
    unit: row.unit,
    description: row.description,
    trackPurchase: !!row.track_purchase,
    purchasePrice: Number(row.purchase_price),
    purchaseAccountId: row.purchase_account_id,
    purchaseTaxId: row.purchase_tax_id,
    trackSale: !!row.track_sale,
    sellingPrice: Number(row.selling_price),
    saleAccountId: row.sale_account_id,
    saleTaxId: row.sale_tax_id,
    imageUrl: row.image_url,
    productType: row.product_type,
    inventoryAccountId: row.inventory_account_id,
    bundleExtraCostAccountId: row.bundle_extra_cost_account_id,
    trackInventory: !!row.track_inventory,
    currentStock: row.current_stock === null ? null : Number(row.current_stock),
    minStock: row.min_stock === null ? null : Number(row.min_stock),
    isActive: !!row.is_active,
    createdAt: row.created_at,
  };
}

async function nextProductCode(businessUnit: string): Promise<string> {
  const [rows] = await pool.query("SELECT COUNT(*) AS cnt FROM products WHERE business_unit = ?", [businessUnit]);
  return String(1001 + (rows as any[])[0].cnt);
}

const SELECT_WITH_CATEGORY = `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN product_categories c ON c.id = p.category_id`;

export const productsController = {
  async list(req: Request, res: Response) {
    const includeArchived = req.query.includeArchived === "true";
    const search = (req.query.search as string) || "";

    const clauses: string[] = ["p.business_unit = ?"];
    const params: unknown[] = [req.businessUnit];
    if (!includeArchived) clauses.push("p.is_active = TRUE");
    if (search) {
      clauses.push("(p.name LIKE ? OR p.code LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;

    const [rows] = await pool.query(`${SELECT_WITH_CATEGORY} ${where} ORDER BY p.name`, params);
    const products = (rows as any[]).map(mapRow);

    // Stat cards only count tracked-inventory products -- services and untracked
    // goods have no stock concept.
    let available = 0;
    let lowStock = 0;
    let outOfStock = 0;
    for (const p of products) {
      if (!p.trackInventory || p.currentStock === null) continue;
      if (p.currentStock <= 0) outOfStock++;
      else if (p.minStock !== null && p.currentStock <= p.minStock) lowStock++;
      else available++;
    }

    const [warehouseRows] = await pool.query("SELECT COUNT(*) AS cnt FROM warehouses WHERE business_unit = ? AND is_active = TRUE", [
      req.businessUnit,
    ]);
    const warehousesRegistered = (warehouseRows as any[])[0].cnt;

    res.json({
      products,
      summary: { available, lowStock, outOfStock, warehousesRegistered },
    });
  },

  async create(req: Request, res: Response) {
    const {
      type,
      name,
      code,
      barcode,
      categoryId,
      unit,
      description,
      trackPurchase,
      purchasePrice,
      purchaseAccountId,
      purchaseTaxId,
      trackSale,
      sellingPrice,
      saleAccountId,
      saleTaxId,
      imageUrl,
      productType,
      inventoryAccountId,
      bundleExtraCostAccountId,
      bundleComponents,
      trackInventory,
      currentStock,
      minStock,
    } = req.body;

    if (!name) throw new ApiError(400, "Nama produk wajib diisi");
    const resolvedType: ProductType = PRODUCT_TYPES.includes(type) ? type : "barang";
    const resolvedProductType = productType === "bundle" ? "bundle" : "single";
    // A bundle is assembled from its components, not bought directly.
    const resolvedTrackPurchase = resolvedProductType === "bundle" ? false : trackPurchase !== false;
    const resolvedTrackSale = trackSale !== false;
    if (resolvedTrackPurchase && !purchaseAccountId) throw new ApiError(400, "Akun pembelian wajib diisi kalau produk ini dibeli");
    if (resolvedTrackSale && !saleAccountId) throw new ApiError(400, "Akun penjualan wajib diisi kalau produk ini dijual");
    const resolvedTrackInventory = resolvedType === "barang" && !!trackInventory;
    const finalCode = code || (await nextProductCode(req.businessUnit));

    // Bundle composition -- which existing qty-tracked Single products make up this
    // bundle, each with a qty. Validated against the DB (not just trusted from the
    // request) so a stale/forged component id or a non-eligible product can't sneak in.
    const validComponents: { productId: number; qty: number }[] = [];
    if (resolvedProductType === "bundle") {
      const requested: { productId?: unknown; qty?: unknown }[] = Array.isArray(bundleComponents) ? bundleComponents : [];
      const componentIds = requested.map((c) => Number(c.productId)).filter((id) => Number.isFinite(id) && id > 0);
      if (!componentIds.length) throw new ApiError(400, "Komponen bundle wajib diisi minimal 1 produk");

      const [componentRows] = await pool.query(
        `SELECT id FROM products WHERE business_unit = ? AND id IN (?) AND product_type = 'single' AND track_inventory = TRUE`,
        [req.businessUnit, componentIds]
      );
      const eligibleIds = new Set((componentRows as any[]).map((r) => r.id));
      for (const c of requested) {
        const productId = Number(c.productId);
        if (!eligibleIds.has(productId)) continue;
        validComponents.push({ productId, qty: Number(c.qty) > 0 ? Number(c.qty) : 1 });
      }
      if (!validComponents.length) throw new ApiError(400, "Komponen bundle harus terdiri dari produk yang dilacak berdasarkan qty");
    }

    const [result] = await pool.query(
      `INSERT INTO products (
         business_unit, type, name, code, barcode, category_id, unit, description,
         track_purchase, purchase_price, purchase_account_id, purchase_tax_id,
         track_sale, selling_price, sale_account_id, sale_tax_id,
         image_url, product_type, inventory_account_id,
         bundle_extra_cost_account_id, track_inventory, current_stock, min_stock
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.businessUnit,
        resolvedType,
        name,
        finalCode,
        barcode || null,
        categoryId || null,
        unit || null,
        description || null,
        resolvedTrackPurchase,
        resolvedTrackPurchase ? Number(purchasePrice) || 0 : 0,
        resolvedTrackPurchase ? purchaseAccountId : null,
        resolvedTrackPurchase && purchaseTaxId ? purchaseTaxId : null,
        resolvedTrackSale,
        resolvedTrackSale ? Number(sellingPrice) || 0 : 0,
        resolvedTrackSale ? saleAccountId : null,
        resolvedTrackSale && saleTaxId ? saleTaxId : null,
        imageUrl || null,
        resolvedProductType,
        resolvedTrackInventory && inventoryAccountId ? inventoryAccountId : null,
        resolvedProductType === "bundle" && bundleExtraCostAccountId ? bundleExtraCostAccountId : null,
        resolvedTrackInventory,
        resolvedTrackInventory ? Number(currentStock) || 0 : null,
        resolvedTrackInventory ? Number(minStock) || 0 : null,
      ]
    );
    const insertId = (result as any).insertId;

    if (validComponents.length) {
      await pool.query(
        `INSERT INTO product_bundle_components (bundle_product_id, component_product_id, qty) VALUES ${validComponents.map(() => "(?, ?, ?)").join(", ")}`,
        validComponents.flatMap((c) => [insertId, c.productId, c.qty])
      );
    }

    // Newly onboarded stock starts "Unassigned" -- nothing has been counted into a
    // specific warehouse yet until a stock adjustment or transfer names one.
    if (resolvedTrackInventory && Number(currentStock) > 0) {
      await adjustWarehouseStock(insertId, null, Number(currentStock));
    }

    const [rows] = await pool.query(`${SELECT_WITH_CATEGORY} WHERE p.id = ?`, [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },

  /** Per-warehouse stock for every qty-tracked product, at one warehouse (null =
   * "Unassigned") -- lets the Transfer Gudang form show "Qty sebelum" live as soon as a
   * "Dari gudang" is picked, instead of only finding out at submit time. */
  async warehouseStock(req: Request, res: Response) {
    const warehouseId = req.query.warehouseId ? Number(req.query.warehouseId) : null;
    const [rows] = await pool.query(
      `SELECT p.id AS product_id, COALESCE(pws.qty, 0) AS qty
       FROM products p
       LEFT JOIN product_warehouse_stock pws ON pws.product_id = p.id AND pws.warehouse_id <=> ?
       WHERE p.business_unit = ? AND p.track_inventory = TRUE`,
      [warehouseId, req.businessUnit]
    );
    res.json((rows as any[]).map((r) => ({ productId: r.product_id, qty: Number(r.qty) })));
  },

  /** Real upload -- saved to disk under uploads/products (see routes/products.routes.ts's
   * multer disk storage) and served back at the returned URL via app.ts's static
   * route. Not tied to a specific product yet; the form uploads the image first, then
   * sends the returned URL along with the rest of the product on create/update. */
  async uploadImage(req: Request, res: Response) {
    if (!req.file) throw new ApiError(400, "File gambar wajib diunggah");
    res.status(201).json({ url: `/uploads/products/${req.file.filename}` });
  },

  async update(req: Request, res: Response) {
    const { name, categoryId, unit, description, purchasePrice, sellingPrice, currentStock, minStock, isActive } = req.body;
    const [existing] = await pool.query("SELECT * FROM products WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current || current.business_unit !== req.businessUnit) throw new ApiError(404, "Produk tidak ditemukan");

    await pool.query(
      `UPDATE products SET name = ?, category_id = ?, unit = ?, description = ?, purchase_price = ?, selling_price = ?, current_stock = ?, min_stock = ?, is_active = ? WHERE id = ?`,
      [
        name ?? current.name,
        categoryId === undefined ? current.category_id : categoryId,
        unit === undefined ? current.unit : unit,
        description === undefined ? current.description : description,
        purchasePrice === undefined ? current.purchase_price : Number(purchasePrice),
        sellingPrice === undefined ? current.selling_price : Number(sellingPrice),
        current.track_inventory ? (currentStock === undefined ? current.current_stock : Number(currentStock)) : null,
        current.track_inventory ? (minStock === undefined ? current.min_stock : Number(minStock)) : null,
        isActive === undefined ? current.is_active : isActive,
        req.params.id,
      ]
    );
    const [rows] = await pool.query(`${SELECT_WITH_CATEGORY} WHERE p.id = ?`, [req.params.id]);
    res.json(mapRow((rows as any[])[0]));
  },
};
