export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

/** Which of the client's two entirely separate businesses a row belongs to -- "zarve"
 * is the existing car-rental business, "b2b" is a new, unrelated business with its own
 * chart of accounts and bookkeeping. See migrations/014_business_unit.sql. */
export type BusinessUnit = "zarve" | "b2b";

export type AccountAccessMode = "all" | "some";

export interface Account {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  parentId: number | null;
  isActive: boolean;
  businessUnit: BusinessUnit;
  description: string | null;
  categoryId: number | null;
  taxId: number | null;
  /** "all" (default) or "some" -- restricted to specific users via
   * account_access_users (see accounts.controller.ts's get/create/update, which are
   * the only places that also expose the actual accessUserIds list). There is no
   * "specific role" option: this app has one "admin" role for everyone. */
  accessMode: AccountAccessMode;
}

/** "Kategori Akun" -- a finer grouping than `AccountType` (e.g. "Cash & Bank" and
 * "Fixed Assets" are both `type: 'asset'`), managed via the B2B Settings screen.
 * `type` is fixed at creation since existing accounts may already rely on it. */
export interface AccountCategory {
  id: number;
  businessUnit: BusinessUnit;
  value: string;
  label: string;
  type: AccountType;
  codeHint: string | null;
  isActive: boolean;
}

export interface TaxCode {
  id: number;
  businessUnit: BusinessUnit;
  name: string;
  rate: number;
  isActive: boolean;
}

export type PartnerType = "customer" | "vendor";

export interface Partner {
  id: number;
  name: string;
  type: PartnerType;
  ktpNumber: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  createdAt: string;
}

export type VehicleCategory = "ev" | "fuel";

export interface Vehicle {
  id: number;
  platNumber: string;
  name: string;
  category: VehicleCategory;
  branch: string | null;
  incomeAccountId: number | null;
  analyticTag: string | null;
}

export type JournalSourceType = "invoice" | "payment" | "manual" | "vendor_bill" | "vendor_payment";

export interface JournalEntry {
  id: number;
  date: string;
  ref: string | null;
  narration: string | null;
  sourceType: JournalSourceType;
  sourceId: number | null;
  businessUnit: BusinessUnit;
}

export interface JournalLine {
  id: number;
  journalEntryId: number;
  accountId: number;
  partnerId: number | null;
  debit: number;
  credit: number;
  analyticTag: string | null;
}

export type InvoiceState = "draft" | "posted";

export interface Invoice {
  id: number;
  number: string;
  partnerId: number;
  vehicleId: number | null;
  invoiceDate: string;
  state: InvoiceState;
  ref: string | null;
  totalAmount: number;
  createdAt: string;
}

export type InvoiceLineCategory = "DAILY" | "THR" | "REFF" | "ADMIN_FEE" | "OTHER";

export interface InvoiceLine {
  id: number;
  invoiceId: number;
  description: string;
  category: InvoiceLineCategory;
  accountId: number;
  accountCode: string;
  accountName: string;
  amount: number;
  taxRate: number;
  taxAmount: number;
}

export interface Payment {
  id: number;
  partnerId: number;
  invoiceId: number | null;
  amount: number;
  date: string;
  method: string | null;
  memo: string | null;
  reconciliationId: number | null;
  createdAt: string;
}

export type ImportBatchState = "done" | "error";

export interface ImportBatch {
  id: number;
  fileName: string;
  periodInfo: string | null;
  totalRows: number;
  totalInvoices: number;
  totalPayments: number;
  state: ImportBatchState;
  errorLog: string | null;
  createdAt: string;
}

export type UserRole = "admin";

export interface User {
  id: number;
  email: string;
  name: string;
  passwordHash: string | null;
  zarveUserId: string | null;
  role: UserRole;
  aktif: boolean;
}

export type PublicUser = Omit<User, "passwordHash">;

export interface ManagedUser extends PublicUser {
  createdAt: string;
}

// "Pemenuhan" order fulfillment board (B2B) -- operational/logistics tracker, not
// wired into the ledger. See migrations/020_orders.sql.
export type OrderType = "sale" | "purchase";
export type OrderStatus = "new" | "processing" | "shipping" | "completed" | "cancelled";

export interface Order {
  id: number;
  businessUnit: BusinessUnit;
  type: OrderType;
  orderNumber: string;
  partyName: string;
  orderDate: string;
  amount: number;
  status: OrderStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// "Produk" -- Barang & Jasa tab only for now (Gudang/warehouse and Aturan Harga are
// deferred). Stock is a plain manual number on the row -- no warehouse/movement
// ledger yet. See migrations/021_products.sql.
export type ProductType = "barang" | "jasa";

export interface ProductCategory {
  id: number;
  businessUnit: BusinessUnit;
  name: string;
  isActive: boolean;
}

export interface Product {
  id: number;
  businessUnit: BusinessUnit;
  type: ProductType;
  name: string;
  code: string;
  barcode: string | null;
  categoryId: number | null;
  categoryName: string | null;
  unit: string | null;
  description: string | null;
  trackPurchase: boolean;
  purchasePrice: number;
  purchaseAccountId: number | null;
  purchaseTaxId: number | null;
  trackSale: boolean;
  sellingPrice: number;
  saleAccountId: number | null;
  saleTaxId: number | null;
  imageUrl: string | null;
  /** "Tipe Produk" from Mekari's form -- Single (one unit) or Bundle (a package).
   * Hardcoded, not Settings-managed -- there are only ever these two values. Bundle
   * composition (linking multiple products together) isn't implemented; this is a
   * label only for now. */
  productType: "single" | "bundle";
  inventoryAccountId: number | null;
  bundleExtraCostAccountId: number | null;
  trackInventory: boolean;
  currentStock: number | null;
  minStock: number | null;
  isActive: boolean;
  createdAt: string;
}

// "Gudang" -- Daftar gudang only (list + create). Stock stays one flat number on the
// product row, not split per warehouse -- so no transfer/approval data exists yet.
// See migrations/022_warehouses.sql.
export interface Warehouse {
  id: number;
  businessUnit: BusinessUnit;
  code: string;
  name: string;
  pics: { id: number; name: string }[];
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

// "Penyesuaian Stok" -- matches Mekari's flow (pick type/category/account/date/
// warehouse, then list product lines). Each line's before/after is that product's
// allocation in the chosen warehouse specifically (product_warehouse_stock); posts a
// journal entry only for lines whose product has a default inventory account set.
// See migrations/030_stock_adjustments.sql, 031_warehouse_stock_and_transfers.sql.
export type StockAdjustmentType = "count" | "in_out";
export type StockAdjustmentCategory = "general" | "damaged" | "production" | "opening_quantity";

export interface StockAdjustmentLine {
  id: number;
  productId: number;
  productName: string;
  productUnit: string | null;
  stockBefore: number;
  stockAfter: number;
}

export interface StockAdjustment {
  id: number;
  businessUnit: BusinessUnit;
  adjustmentNumber: string;
  type: StockAdjustmentType;
  category: StockAdjustmentCategory;
  accountId: number | null;
  warehouseId: number | null;
  warehouseName: string | null;
  adjustmentDate: string;
  memo: string | null;
  journalEntryId: number | null;
  lines: StockAdjustmentLine[];
  createdAt: string;
}

// "Transfer Gudang" -- moves qty of qty-tracked products between two warehouse
// allocations (product_warehouse_stock). Doesn't change products.current_stock (the
// total across every warehouse) -- only the per-warehouse split. See
// migrations/031_warehouse_stock_and_transfers.sql.
export interface WarehouseTransferLine {
  id: number;
  productId: number;
  productName: string;
  productUnit: string | null;
  qtyBefore: number;
  qtyAfter: number;
  qtyTransferred: number;
}

export interface WarehouseTransferAttachment {
  id: number;
  fileName: string;
  url: string;
}

export interface WarehouseTransfer {
  id: number;
  businessUnit: BusinessUnit;
  transferNumber: string;
  fromWarehouseId: number | null;
  fromWarehouseName: string | null;
  toWarehouseId: number | null;
  toWarehouseName: string | null;
  transferDate: string;
  memo: string | null;
  lines: WarehouseTransferLine[];
  attachments: WarehouseTransferAttachment[];
  createdAt: string;
}

// "Kontak" -- a B2B-only contact book (Pelanggan/Supplier/Karyawan/Lainnya), a separate
// table from `partners` (which is tied to Zarve's driver-import matching logic). No
// AR/AP balance tracking exists for B2B yet, so "Saldo" is always 0 for now. See
// migrations/032_contacts.sql.
export type ContactType = "customer" | "vendor" | "employee" | "other";

export interface Contact {
  id: number;
  businessUnit: BusinessUnit;
  type: ContactType;
  name: string;
  companyName: string | null;
  address: string | null;
  email: string | null;
  mobilePhone: string | null;
  phone: string | null;
  npwp: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}
