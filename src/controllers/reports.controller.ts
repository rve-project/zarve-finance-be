import { Request, Response } from "express";
import * as XLSX from "xlsx";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { AccountBalanceRow, getAccountBalances, getGeneralLedgerLines } from "../utils/reportEngine";
import { toUtcIso } from "../utils/zarveMirror";
import { getAccountIdByCode, WELL_KNOWN_ACCOUNTS } from "../utils/ledger";
import { BusinessUnit } from "../models/types";

const EPOCH = "1970-01-01";

/** The 5 financial-statement reports below (not aged-receivables, GL, etc.) accept a
 * third "Konsolidasi" option on top of the usual X-Business-Unit b2b/zarve header --
 * handled entirely in this controller via getAccountBalances' own "consolidated"
 * support (see reportEngine.ts), so resolveBusinessUnit's global middleware/type stays
 * untouched and every other endpoint keeps behaving exactly as before. */
type ReportUnit = BusinessUnit | "consolidated";
function resolveReportUnit(req: Request): ReportUnit {
  return req.headers["x-business-unit"] === "consolidated" ? "consolidated" : req.businessUnit;
}

/** Shared xlsx-buffer responder for every report export below -- one sheet, a title
 * row, then a header row, then data rows (plain arrays, SheetJS infers columns). */
function sendXlsx(res: Response, sheetName: string, filename: string, title: string, header: string[], rows: (string | number)[][]) {
  const sheetData = [[title], header, ...rows];
  const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function requireDateRange(req: Request): { from: string; to: string } {
  const from = (req.query.from as string) || EPOCH;
  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
  return { from, to };
}

/** Shared between balanceSheet and exportBalanceSheet -- see the synthetic
 * "Laba Ditahan (Berjalan)" row comment inline below for why this exists. */
async function buildBalanceSheet(businessUnit: ReportUnit, asOf: string) {
  const rows = await getAccountBalances({ from: EPOCH, to: asOf, businessUnit });

  const assets = rows.filter((r) => r.account.type === "asset");
  const liabilities = rows.filter((r) => r.account.type === "liability");
  const equity = rows.filter((r) => r.account.type === "equity");

  // Income/expense accounts aren't part of the balance sheet on their own, but their
  // net (since inception) IS part of equity -- without a period-closing step (which
  // this system doesn't do), cumulative net income has nowhere else to live. Without
  // this line, Assets would never equal Liabilities + Equity for a business that's
  // actually made money. Same convention most accounting software uses for an as-of
  // balance sheet before formal year-end closing (e.g. Xero/QuickBooks' "Net Income"
  // equity line).
  const incomeExpenseRows = rows.filter((r) => r.account.type === "income" || r.account.type === "expense");
  const netIncomeToDate = incomeExpenseRows.reduce(
    (sum, r) => sum + (r.account.type === "income" ? r.endBalance : -r.endBalance),
    0
  );
  const netIncomeRow: AccountBalanceRow = {
    account: {
      id: 0,
      code: "3900",
      name: "Laba Ditahan (Berjalan)",
      type: "equity" as const,
      parentId: null,
      isActive: true,
      // Synthetic row, never a real accounts table record -- "consolidated" isn't a
      // valid Account.businessUnit, so tag it b2b arbitrarily; the FE only shows a
      // per-row unit badge for real (id !== 0) rows anyway.
      businessUnit: businessUnit === "consolidated" ? "b2b" : businessUnit,
      description: null,
      categoryId: null,
      taxId: null,
      bankName: null,
      accessMode: "all",
    },
    initialBalance: 0,
    periodDebit: 0,
    periodCredit: 0,
    endBalance: netIncomeToDate,
  };
  const equityWithNetIncome = [...equity, netIncomeRow];

  const totalAssets = assets.reduce((sum, r) => sum + r.endBalance, 0);
  const totalLiabilities = liabilities.reduce((sum, r) => sum + r.endBalance, 0);
  const totalEquity = equityWithNetIncome.reduce((sum, r) => sum + r.endBalance, 0);

  return {
    asOf,
    assets,
    liabilities,
    equity: equityWithNetIncome,
    totalAssets,
    totalLiabilities,
    totalEquity,
  };
}

/**
 * Laporan Perubahan Modal (Statement of Changes in Equity). Reuses the exact same
 * cumulative-since-epoch convention as buildBalanceSheet's synthetic "Laba Ditahan
 * (Berjalan)" row -- this system never posts a period-closing entry, so an equity
 * account's `initialBalance` from getAccountBalances (sum of everything before `from`)
 * already IS "Saldo Awal" for this report, and `endBalance` already IS "Saldo Akhir".
 * Net income needs its own synthetic row for the same reason the balance sheet does:
 * income/expense accounts aren't equity accounts, but their running total since
 * inception belongs in equity. The beginning/ending split here (rather than
 * balanceSheet's single as-of total) is what makes the two reports reconcile: running
 * this report with `to` equal to a balance sheet's `asOf` date, `totalEnding` here must
 * equal that balance sheet's `totalEquity`.
 */
async function buildEquityChanges(businessUnit: ReportUnit, from: string, to: string) {
  const equityRows = await getAccountBalances({ from, to, types: ["equity"], businessUnit });
  const incomeExpenseRows = await getAccountBalances({ from, to, types: ["income", "expense"], businessUnit });

  const netIncomeBeginning = incomeExpenseRows.reduce(
    (sum, r) => sum + (r.account.type === "income" ? r.initialBalance : -r.initialBalance),
    0
  );
  const netIncomeEnding = incomeExpenseRows.reduce(
    (sum, r) => sum + (r.account.type === "income" ? r.endBalance : -r.endBalance),
    0
  );
  const netIncomeRow: AccountBalanceRow = {
    account: {
      id: 0,
      code: "3900",
      name: "Laba Ditahan (Berjalan)",
      type: "equity" as const,
      parentId: null,
      isActive: true,
      businessUnit: businessUnit === "consolidated" ? "b2b" : businessUnit,
      description: null,
      categoryId: null,
      taxId: null,
      bankName: null,
      accessMode: "all",
    },
    initialBalance: netIncomeBeginning,
    periodDebit: 0,
    periodCredit: 0,
    endBalance: netIncomeEnding,
  };

  const rows = [...equityRows, netIncomeRow];
  const totalBeginning = rows.reduce((sum, r) => sum + r.initialBalance, 0);
  const totalEnding = rows.reduce((sum, r) => sum + r.endBalance, 0);

  return { from, to, rows, totalBeginning, totalMovement: totalEnding - totalBeginning, totalEnding };
}

/** Shared between cashFlow and exportCashFlow -- see cashFlow's own doc comment below
 * for why the cash-account detection differs between business units.
 *
 * Unlike the other 4 reports, "consolidated" can't just drop getAccountBalances'
 * business_unit filter here -- the cash-account detection itself is a different query
 * per unit (category lookup for b2b, code prefix for zarve), not just a WHERE clause on
 * accounts. So consolidated mode runs both units' builds independently and sums the
 * resulting totals -- each unit's own cash-account detection stays untouched. */
interface CashFlowResult {
  from: string;
  to: string;
  accounts: AccountBalanceRow[];
  beginningBalance: number;
  cashIn: number;
  cashOut: number;
  netChange: number;
  endingBalance: number;
}

async function buildCashFlow(businessUnit: ReportUnit, from: string, to: string): Promise<CashFlowResult> {
  if (businessUnit === "consolidated") {
    const [b2b, zarve] = await Promise.all([buildCashFlow("b2b", from, to), buildCashFlow("zarve", from, to)]);
    return {
      from,
      to,
      accounts: [...b2b.accounts, ...zarve.accounts],
      beginningBalance: b2b.beginningBalance + zarve.beginningBalance,
      cashIn: b2b.cashIn + zarve.cashIn,
      cashOut: b2b.cashOut + zarve.cashOut,
      netChange: b2b.netChange + zarve.netChange,
      endingBalance: b2b.endingBalance + zarve.endingBalance,
    };
  }

  const rows = await getAccountBalances({ from, to, types: ["asset"], businessUnit });

  let cashAccounts;
  if (businessUnit === "b2b") {
    const [catRows] = await pool.query("SELECT id FROM account_categories WHERE business_unit = 'b2b' AND value = 'cash_bank'");
    const cashBankCategoryId = (catRows as any[])[0]?.id;
    cashAccounts = rows.filter((r) => r.account.categoryId === cashBankCategoryId);
  } else {
    cashAccounts = rows.filter((r) => r.account.code.startsWith("11"));
  }

  const beginningBalance = cashAccounts.reduce((sum, r) => sum + r.initialBalance, 0);
  const endingBalance = cashAccounts.reduce((sum, r) => sum + r.endBalance, 0);
  const cashIn = cashAccounts.reduce((sum, r) => sum + r.periodDebit, 0);
  const cashOut = cashAccounts.reduce((sum, r) => sum + r.periodCredit, 0);

  return {
    from,
    to,
    accounts: cashAccounts,
    beginningBalance,
    cashIn,
    cashOut,
    netChange: cashIn - cashOut,
    endingBalance,
  };
}

export const reportsController = {
  async trialBalance(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);
    const rows = await getAccountBalances({ from, to, businessUnit: resolveReportUnit(req) });
    res.json({ from, to, rows });
  },

  async exportTrialBalance(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);
    const rows = await getAccountBalances({ from, to, businessUnit: resolveReportUnit(req) });
    const active = rows.filter((r) => r.initialBalance !== 0 || r.periodDebit !== 0 || r.periodCredit !== 0 || r.endBalance !== 0);

    sendXlsx(
      res,
      "Trial Balance",
      `Trial Balance ${from} - ${to}.xlsx`,
      `Trial Balance ${from} s/d ${to}`,
      ["Kode", "Nama Akun", "Saldo Awal", "Debit", "Kredit", "Saldo Akhir"],
      active.map((r) => [r.account.code, r.account.name, r.initialBalance, r.periodDebit, r.periodCredit, r.endBalance])
    );
  },

  async generalLedger(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);
    const accountId = Number(req.query.accountId);
    if (!accountId) throw new ApiError(400, "accountId wajib diisi");
    const [accountRows] = await pool.query("SELECT business_unit FROM accounts WHERE id = ?", [accountId]);
    const account = (accountRows as any[])[0];
    if (!account || account.business_unit !== req.businessUnit) throw new ApiError(404, "Akun tidak ditemukan");
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const { lines, total, totalDebit, totalCredit, endBalance } = await getGeneralLedgerLines(accountId, from, to, page, limit);
    res.json({ from, to, accountId, lines, total, page, limit, totalDebit, totalCredit, endBalance });
  },

  async exportGeneralLedger(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);
    const accountId = Number(req.query.accountId);
    if (!accountId) throw new ApiError(400, "accountId wajib diisi");
    const [accountRows] = await pool.query("SELECT code, name, business_unit FROM accounts WHERE id = ?", [accountId]);
    const account = (accountRows as any[])[0];
    if (!account || account.business_unit !== req.businessUnit) throw new ApiError(404, "Akun tidak ditemukan");

    // No pagination here -- the whole account/period's movement goes into the file,
    // unlike the JSON endpoint above which pages for the on-screen table.
    const { lines } = await getGeneralLedgerLines(accountId, from, to, 1, Number.MAX_SAFE_INTEGER);

    sendXlsx(
      res,
      "General Ledger",
      `General Ledger ${account.code} ${from} - ${to}.xlsx`,
      `General Ledger - ${account.code} ${account.name} (${from} s/d ${to})`,
      ["Tanggal", "Ref", "Partner", "Keterangan", "Debit", "Kredit", "Saldo"],
      lines.map((l) => [l.date, l.ref ?? "", l.partnerName ?? "", l.narration ?? "", l.debit, l.credit, l.runningBalance])
    );
  },

  async profitAndLoss(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);
    const rows = await getAccountBalances({ from, to, types: ["income", "expense"], businessUnit: resolveReportUnit(req) });

    const income = rows.filter((r) => r.account.type === "income");
    const expense = rows.filter((r) => r.account.type === "expense");
    const totalIncome = income.reduce((sum, r) => sum + r.periodCredit - r.periodDebit, 0);
    const totalExpense = expense.reduce((sum, r) => sum + r.periodDebit - r.periodCredit, 0);

    res.json({
      from,
      to,
      income,
      expense,
      totalIncome,
      totalExpense,
      netProfit: totalIncome - totalExpense,
    });
  },

  async exportProfitAndLoss(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);
    const rows = await getAccountBalances({ from, to, types: ["income", "expense"], businessUnit: resolveReportUnit(req) });

    const income = rows.filter((r) => r.account.type === "income" && (r.periodCredit !== 0 || r.periodDebit !== 0));
    const expense = rows.filter((r) => r.account.type === "expense" && (r.periodDebit !== 0 || r.periodCredit !== 0));
    const totalIncome = income.reduce((sum, r) => sum + r.periodCredit - r.periodDebit, 0);
    const totalExpense = expense.reduce((sum, r) => sum + r.periodDebit - r.periodCredit, 0);

    const dataRows: (string | number)[][] = [
      ["Pendapatan", ""],
      ...income.map((r) => [r.account.name, r.periodCredit - r.periodDebit]),
      ["Total Pendapatan", totalIncome],
      ["", ""],
      ["Beban", ""],
      ...expense.map((r) => [r.account.name, r.periodDebit - r.periodCredit]),
      ["Total Beban", totalExpense],
      ["", ""],
      ["Laba Bersih", totalIncome - totalExpense],
    ];

    sendXlsx(
      res,
      "Laba Rugi",
      `Laba Rugi ${from} - ${to}.xlsx`,
      `Laba Rugi ${from} s/d ${to}`,
      ["Nama Akun", "Jumlah"],
      dataRows
    );
  },

  async balanceSheet(req: Request, res: Response) {
    const asOf = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);
    const result = await buildBalanceSheet(resolveReportUnit(req), asOf);
    res.json(result);
  },

  async exportBalanceSheet(req: Request, res: Response) {
    const asOf = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);
    const { assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity } = await buildBalanceSheet(resolveReportUnit(req), asOf);

    const section = (title: string, rows: AccountBalanceRow[], total: number): (string | number)[][] => [
      [title, ""],
      ...rows.filter((r) => r.endBalance !== 0).map((r) => [r.account.name, r.endBalance]),
      [`Total ${title}`, total],
      ["", ""],
    ];

    sendXlsx(
      res,
      "Neraca",
      `Neraca ${asOf}.xlsx`,
      `Neraca per ${asOf}`,
      ["Nama Akun", "Saldo"],
      [
        ...section("Aset", assets, totalAssets),
        ...section("Liabilitas", liabilities, totalLiabilities),
        ...section("Ekuitas", equity, totalEquity),
        ["Total Liabilitas + Ekuitas", totalLiabilities + totalEquity],
      ]
    );
  },

  async equityChanges(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);
    const result = await buildEquityChanges(resolveReportUnit(req), from, to);
    res.json(result);
  },

  async exportEquityChanges(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);
    const { rows, totalBeginning, totalMovement, totalEnding } = await buildEquityChanges(resolveReportUnit(req), from, to);

    sendXlsx(
      res,
      "Perubahan Modal",
      `Laporan Perubahan Modal ${from} - ${to}.xlsx`,
      `Laporan Perubahan Modal ${from} s/d ${to}`,
      ["Kode", "Nama Akun", "Saldo Awal", "Perubahan", "Saldo Akhir"],
      [
        ...rows.map((r) => [r.account.code, r.account.name, r.initialBalance, r.endBalance - r.initialBalance, r.endBalance]),
        ["", "Total Ekuitas", totalBeginning, totalMovement, totalEnding],
      ]
    );
  },

  /**
   * Simplified cash flow: net movement on Bank/Cash accounts within the period. Does
   * NOT split into operating/investing/financing like Odoo's version -- flagged in the
   * plan as a follow-up refinement, not silently under-built.
   *
   * Zarve accounts don't use account_categories at all (see migration
   * 017_account_categories_and_taxes.sql), so Zarve keeps its old code-prefix '11'
   * convention; B2B's codes don't follow that convention (see 034_full_b2b_coa.sql),
   * so B2B instead matches its "Cash & Bank" category.
   */
  async cashFlow(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);
    res.json(await buildCashFlow(resolveReportUnit(req), from, to));
  },

  async exportCashFlow(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);
    const { accounts, beginningBalance, cashIn, cashOut, endingBalance } = await buildCashFlow(resolveReportUnit(req), from, to);

    sendXlsx(
      res,
      "Arus Kas",
      `Arus Kas ${from} - ${to}.xlsx`,
      `Arus Kas ${from} s/d ${to}`,
      ["Akun", "Saldo Awal", "Masuk", "Keluar", "Saldo Akhir"],
      [
        ...accounts.map((r) => [r.account.name, r.initialBalance, r.periodDebit, r.periodCredit, r.endBalance]),
        ["Total", beginningBalance, cashIn, cashOut, endingBalance],
      ]
    );
  },

  /**
   * How much each customer/driver owes, bucketed by how long it's been outstanding.
   * Zarve has no separate due-date field (a rental invoice's obligation starts on the
   * invoice date itself) and reads straight from `invoices`/`payments` -- the Zarve-only
   * tables from 014_business_unit.sql. B2B's `sale_documents` DOES have a real
   * `due_date`, so its branch buckets off that instead, which is the more accurate
   * anchor. Both branches alias their result columns to the same names so they share one
   * bucketing loop below. vehicleProfitability and geofenceViolations below remain
   * Zarve-only/unscoped -- don't extend those the same way without equivalent B2B data
   * to back them.
   */
  async agedReceivables(req: Request, res: Response) {
    const asOf = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);
    // Optional -- the detail page for one driver/customer reuses this same endpoint
    // and computation instead of duplicating the bucket math.
    const partnerId = req.query.partnerId ? Number(req.query.partnerId) : undefined;

    // B2B's sale_documents has a real due_date (and credit notes via "exchange" docs);
    // Zarve's invoices table has neither, so its branch falls back to invoice_date as
    // the aging anchor and a constant 0 for credited. Aliasing both branches to the
    // same column names (invoice_date, credited) lets them share one bucketing loop
    // below instead of duplicating it per business unit.
    const [rows] =
      req.businessUnit === "b2b"
        ? await pool.query(
            `SELECT sd.id, sd.number, sd.contact_id AS partner_id, c.name AS partner_name,
                    COALESCE(sd.due_date, sd.document_date) AS invoice_date, sd.total_amount,
                    (SELECT COALESCE(SUM(amount), 0) FROM sale_payments WHERE document_id = sd.id AND payment_date <= ?) AS paid,
                    (SELECT COALESCE(SUM(sdl.amount), 0) FROM sale_document_lines sdl
                       JOIN sale_documents ex ON ex.id = sdl.document_id
                       WHERE sdl.target_document_id = sd.id AND ex.status = 'approved') AS credited
             FROM sale_documents sd
             LEFT JOIN contacts c ON c.id = sd.contact_id
             WHERE sd.business_unit = 'b2b' AND sd.doc_type = 'invoice' AND sd.status = 'approved'
               AND COALESCE(sd.due_date, sd.document_date) <= ? ${partnerId ? "AND sd.contact_id = ?" : ""}`,
            partnerId ? [asOf, asOf, partnerId] : [asOf, asOf]
          )
        : await pool.query(
            `SELECT i.id, i.number, i.partner_id, p.name AS partner_name, i.invoice_date, i.total_amount,
               COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id AND date <= ?), 0) AS paid,
               0 AS credited
             FROM invoices i
             JOIN partners p ON p.id = i.partner_id
             WHERE i.invoice_date <= ? ${partnerId ? "AND i.partner_id = ?" : ""}`,
            partnerId ? [asOf, asOf, partnerId] : [asOf, asOf]
          );

    const asOfMs = new Date(asOf).getTime();
    type Bucket = "current" | "d1to30" | "d31to60" | "d61to90" | "d90plus";
    type InvoiceDetail = { invoiceId: number; invoiceNumber: string; invoiceDate: string; totalAmount: number; paid: number; outstanding: number; bucket: Bucket };
    const byPartner = new Map<
      number,
      {
        partnerId: number;
        partnerName: string;
        current: number;
        d1to30: number;
        d31to60: number;
        d61to90: number;
        d90plus: number;
        total: number;
        invoices: InvoiceDetail[];
      }
    >();

    for (const r of rows as any[]) {
      const outstanding = Number(r.total_amount) - Number(r.paid) - Number(r.credited ?? 0);
      if (outstanding <= 0.01) continue;

      let entry = byPartner.get(r.partner_id);
      if (!entry) {
        entry = { partnerId: r.partner_id, partnerName: r.partner_name, current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0, total: 0, invoices: [] };
        byPartner.set(r.partner_id, entry);
      }

      const days = Math.floor((asOfMs - new Date(r.invoice_date).getTime()) / (24 * 60 * 60 * 1000));
      const bucket: Bucket = days <= 0 ? "current" : days <= 30 ? "d1to30" : days <= 60 ? "d31to60" : days <= 90 ? "d61to90" : "d90plus";
      entry[bucket] += outstanding;
      entry.total += outstanding;
      entry.invoices.push({
        invoiceId: r.id,
        invoiceNumber: r.number,
        invoiceDate: r.invoice_date,
        totalAmount: Number(r.total_amount),
        paid: Number(r.paid) + Number(r.credited ?? 0),
        outstanding,
        bucket,
      });
    }

    for (const entry of byPartner.values()) {
      entry.invoices.sort((a, b) => new Date(a.invoiceDate).getTime() - new Date(b.invoiceDate).getTime());
    }

    const partners = Array.from(byPartner.values()).sort((a, b) => b.total - a.total);
    res.json({
      asOf,
      partners,
      totals: partners.reduce(
        (acc, p) => ({
          current: acc.current + p.current,
          d1to30: acc.d1to30 + p.d1to30,
          d31to60: acc.d31to60 + p.d31to60,
          d61to90: acc.d61to90 + p.d61to90,
          d90plus: acc.d90plus + p.d90plus,
          total: acc.total + p.total,
        }),
        { current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0, total: 0 }
      ),
    });
  },

  /**
   * Revenue and expense per vehicle -- "which cars are actually profitable", a natural
   * question for a rental fleet that the generic P&L can't answer. Joins invoices'
   * `vehicle_id` (income side) and vendor_bill_lines' `vehicle_id` (expense side,
   * when a bill line is tagged to a specific vehicle) rather than the vestigial
   * `analytic_tag` column, which nothing ever populated.
   */
  async vehicleProfitability(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);

    const [incomeRows] = await pool.query(
      `SELECT i.vehicle_id, v.plate_number, v.name AS vehicle_name, COALESCE(SUM(il.amount), 0) AS income
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       JOIN accounts a ON a.id = il.account_id
       LEFT JOIN vehicles v ON v.id = i.vehicle_id
       WHERE a.type = 'income' AND i.invoice_date BETWEEN ? AND ? AND i.vehicle_id IS NOT NULL
       GROUP BY i.vehicle_id, v.plate_number, v.name`,
      [from, to]
    );

    const [expenseRows] = await pool.query(
      `SELECT vbl.vehicle_id, v.plate_number, v.name AS vehicle_name, COALESCE(SUM(vbl.amount), 0) AS expense
       FROM vendor_bill_lines vbl
       JOIN vendor_bills vb ON vb.id = vbl.vendor_bill_id
       LEFT JOIN vehicles v ON v.id = vbl.vehicle_id
       WHERE vbl.vehicle_id IS NOT NULL AND vb.bill_date BETWEEN ? AND ?
       GROUP BY vbl.vehicle_id, v.plate_number, v.name`,
      [from, to]
    );

    const byVehicle = new Map<number, { vehicleId: number; platNumber: string; name: string; income: number; expense: number }>();
    for (const r of incomeRows as any[]) {
      byVehicle.set(r.vehicle_id, { vehicleId: r.vehicle_id, platNumber: r.plate_number, name: r.vehicle_name, income: Number(r.income), expense: 0 });
    }
    for (const r of expenseRows as any[]) {
      const existing = byVehicle.get(r.vehicle_id);
      if (existing) existing.expense = Number(r.expense);
      else byVehicle.set(r.vehicle_id, { vehicleId: r.vehicle_id, platNumber: r.plate_number, name: r.vehicle_name, income: 0, expense: Number(r.expense) });
    }

    const vehicles = Array.from(byVehicle.values())
      .map((v) => ({ ...v, profit: v.income - v.expense }))
      .sort((a, b) => b.profit - a.profit);

    res.json({ from, to, vehicles });
  },

  /**
   * "Keluar kota" (geofence) billing -- what the owner actually asked for: how much
   * has been billed for units leaving their working area, how much is sitting
   * unbilled (OPEN, no invoice yet), and how much was waived, for a period. Mirrors
   * Zarve's own /working-area/violations/summary categories (open/invoiced/waived)
   * rather than inventing new ones, plus a per-record list for follow-up (which
   * driver/vehicle, when they left, whether they've been detected coming back).
   */
  async geofenceViolations(req: Request, res: Response) {
    const { from, to } = requireDateRange(req);
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;

    const [summaryRows] = await pool.query(
      `SELECT status, COUNT(*) AS cnt, COALESCE(SUM(price), 0) AS amount
       FROM zarve_geofence_violations
       WHERE violation_date BETWEEN ? AND ?
       GROUP BY status`,
      [from, to]
    );
    const summary = { open: { count: 0, amount: 0 }, invoiced: { count: 0, amount: 0 }, waived: { count: 0, amount: 0 } };
    for (const r of summaryRows as any[]) {
      const key = String(r.status).toLowerCase();
      if (key in summary) summary[key as keyof typeof summary] = { count: Number(r.cnt), amount: Number(r.amount) };
    }
    const total = {
      count: summary.open.count + summary.invoiced.count + summary.waived.count,
      amount: summary.open.amount + summary.invoiced.amount + summary.waived.amount,
    };

    const [countRows] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM zarve_geofence_violations WHERE violation_date BETWEEN ? AND ?",
      [from, to]
    );
    const rowTotal = (countRows as any[])[0].cnt as number;

    const [rows] = await pool.query(
      `SELECT * FROM zarve_geofence_violations WHERE violation_date BETWEEN ? AND ?
       ORDER BY violation_date DESC, detected_at DESC LIMIT ? OFFSET ?`,
      [from, to, limit, (page - 1) * limit]
    );

    res.json({
      from,
      to,
      summary: { ...summary, total },
      total: rowTotal,
      page,
      limit,
      data: (rows as any[]).map((r) => ({
        id: r.id,
        violationDate: r.violation_date,
        detectedAt: toUtcIso(r.detected_at),
        returnedAt: toUtcIso(r.returned_at),
        vehiclePlate: r.vehicle_plate,
        driverName: r.driver_name,
        geofenceName: r.geofence_name,
        price: Number(r.price),
        status: r.status,
        invoiceId: r.invoice_id,
        invoiceNumber: r.invoice_number,
      })),
    });
  },

  /**
   * D'Consulting audit gaps #6/#7: a runnable "trial test" the team can check any time,
   * covering both Zarve and B2B, manual and Zarve-synced transactions -- not a one-off
   * migration script.
   *
   *  1. Orphan check: every transaction table that should post a journal entry, but
   *     doesn't have one. Structurally this should never happen (every create path posts
   *     its journal entry in the same DB transaction) -- this is the safety net that
   *     actually proves it, instead of just trusting the code.
   *  2. Trial balance check: per business unit, total debit must equal total credit.
   *  3. Subledger vs GL check: AR/AP per subledger (unpaid invoices/bills) vs the
   *     corresponding GL account balance.
   */
  async journalValidation(_req: Request, res: Response) {
    const orphanChecks: { label: string; businessUnit: "zarve" | "b2b" | null; sql: string }[] = [
      {
        label: "invoices",
        businessUnit: "zarve",
        sql: `SELECT i.id, i.number AS ref FROM invoices i
              LEFT JOIN journal_entries je ON je.source_type = 'invoice' AND je.source_id = i.id
              WHERE je.id IS NULL`,
      },
      {
        label: "payments",
        businessUnit: "zarve",
        sql: `SELECT p.id, CONCAT('PAY-', p.id) AS ref FROM payments p
              LEFT JOIN journal_entries je ON je.source_type = 'payment' AND je.source_id = p.id
              WHERE je.id IS NULL`,
      },
      {
        label: "vendor_bills",
        businessUnit: "zarve",
        sql: `SELECT vb.id, vb.number AS ref FROM vendor_bills vb
              LEFT JOIN journal_entries je ON je.source_type = 'vendor_bill' AND je.source_id = vb.id
              WHERE je.id IS NULL`,
      },
      {
        label: "vendor_payments",
        businessUnit: "zarve",
        sql: `SELECT vp.id, CONCAT('VPAY-', vp.id) AS ref FROM vendor_payments vp
              LEFT JOIN journal_entries je ON je.source_type = 'vendor_payment' AND je.source_id = vp.id
              WHERE je.id IS NULL`,
      },
      {
        label: "fixed_assets",
        businessUnit: null,
        sql: `SELECT fa.id, fa.asset_number AS ref FROM fixed_assets fa WHERE fa.purchase_journal_entry_id IS NULL`,
      },
      {
        label: "expenses",
        businessUnit: null,
        sql: `SELECT e.id, e.number AS ref FROM expenses e
              LEFT JOIN journal_entries je ON je.source_type = 'expense' AND je.source_id = e.id
              WHERE je.id IS NULL`,
      },
      {
        label: "sale_invoices",
        businessUnit: null,
        sql: `SELECT sd.id, sd.number AS ref FROM sale_documents sd
              LEFT JOIN journal_entries je ON je.source_type = 'sale_invoice' AND je.source_id = sd.id
              WHERE sd.doc_type = 'invoice' AND sd.status = 'approved' AND je.id IS NULL`,
      },
      {
        label: "purchase_invoices",
        businessUnit: null,
        sql: `SELECT pd.id, pd.number AS ref FROM purchase_documents pd
              LEFT JOIN journal_entries je ON je.source_type = 'purchase_invoice' AND je.source_id = pd.id
              WHERE pd.doc_type = 'invoice' AND pd.status = 'approved' AND je.id IS NULL`,
      },
    ];

    const orphanTransactions: { type: string; id: number; ref: string | null }[] = [];
    for (const check of orphanChecks) {
      const [rows] = await pool.query(check.sql);
      for (const r of rows as any[]) {
        orphanTransactions.push({ type: check.label, id: r.id, ref: r.ref });
      }
    }

    const [balanceRows] = await pool.query(
      `SELECT je.business_unit, COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
       FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id = je.id
       GROUP BY je.business_unit`
    );
    const trialBalance = (balanceRows as any[]).map((r) => ({
      businessUnit: r.business_unit,
      totalDebit: round2(Number(r.total_debit)),
      totalCredit: round2(Number(r.total_credit)),
      balanced: round2(Number(r.total_debit)) === round2(Number(r.total_credit)),
    }));

    const subledgerMismatches: { label: string; subledgerTotal: number; glTotal: number; difference: number }[] = [];

    // Zarve AR: one well-known account for every partner.
    {
      const [rows] = await pool.query(
        `SELECT COALESCE(SUM(i.total_amount), 0) - COALESCE((SELECT SUM(amount) FROM payments), 0) AS outstanding FROM invoices i`
      );
      const subledgerTotal = round2(Number((rows as any[])[0].outstanding));
      const arAccountId = await getAccountIdByCode(WELL_KNOWN_ACCOUNTS.ACCOUNTS_RECEIVABLE, "zarve");
      const [glRows] = await pool.query(
        `SELECT COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS balance FROM journal_lines jl WHERE jl.account_id = ?`,
        [arAccountId]
      );
      const glTotal = round2(Number((glRows as any[])[0].balance));
      const difference = round2(subledgerTotal - glTotal);
      if (Math.abs(difference) > 0.01) subledgerMismatches.push({ label: "Piutang Usaha (Zarve)", subledgerTotal, glTotal, difference });
    }

    // B2B AR/AP: contacts can override the account per-contact, so the GL side sums
    // every distinct receivable/payable account actually in use, not just the default.
    async function b2bSubledgerVsGl(
      docTable: "sale_documents" | "purchase_documents",
      paymentTable: "sale_payments" | "purchase_payments",
      contactAccountColumn: "receivable_account_id" | "payable_account_id",
      defaultAccountCode: string,
      label: string
    ) {
      const [rows] = await pool.query(
        `SELECT COALESCE(SUM(x.outstanding), 0) AS outstanding FROM (
           SELECT d.total_amount - COALESCE((SELECT SUM(amount) FROM ${paymentTable} WHERE document_id = d.id), 0) AS outstanding
           FROM ${docTable} d WHERE d.business_unit = 'b2b' AND d.doc_type = 'invoice' AND d.status = 'approved'
         ) x`
      );
      const subledgerTotal = round2(Number((rows as any[])[0]?.outstanding ?? 0));

      const defaultAccountId = await getAccountIdByCode(defaultAccountCode, "b2b");
      const [accountRows] = await pool.query(
        `SELECT DISTINCT ${contactAccountColumn} AS account_id FROM contacts WHERE business_unit = 'b2b' AND ${contactAccountColumn} IS NOT NULL`
      );
      const accountIds = Array.from(new Set([defaultAccountId, ...(accountRows as any[]).map((r) => r.account_id)]));

      const [glRows] = await pool.query(
        `SELECT COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS balance FROM journal_lines jl WHERE jl.account_id IN (?)`,
        [accountIds]
      );
      const glTotal = round2(Number((glRows as any[])[0].balance));
      const difference = round2(subledgerTotal - glTotal);
      if (Math.abs(difference) > 0.01) subledgerMismatches.push({ label, subledgerTotal, glTotal, difference });
    }

    await b2bSubledgerVsGl("sale_documents", "sale_payments", "receivable_account_id", "1-10100", "Piutang Usaha (B2B)");
    await b2bSubledgerVsGl("purchase_documents", "purchase_payments", "payable_account_id", "2-20100", "Utang Usaha (B2B)");

    res.json({ orphanTransactions, trialBalance, subledgerMismatches });
  },
};
