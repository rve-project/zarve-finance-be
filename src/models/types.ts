export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface Account {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  parentId: number | null;
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
