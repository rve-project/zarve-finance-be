import { Request, Response } from "express";
import { pool } from "../db";
import { buildSyncRows, ZarveSyncRow, SyncVehicleType } from "../utils/zarveSync";
import { fetchMirrorInvoices, getMirrorCompanies } from "../utils/zarveMirror";
import { findOrCreatePartner } from "./partners.controller";
import { findVehicleByPlate, normalizePlate } from "./vehicles.controller";
import { createInvoice, findInvoiceByKey } from "./invoices.controller";
import { createPayment } from "./payments.controller";
import { getAccountIdByCode, WELL_KNOWN_ACCOUNTS } from "../utils/ledger";
import { AppSettings, getSettings } from "../utils/settings";

const MONTH_NAMES_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

function formatPeriodId(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES_ID[m - 1]} ${y}`;
}

async function findOrCreateVehicle(
  name: string,
  plate: string,
  vehicleType: SyncVehicleType,
  settings: AppSettings
): Promise<{ id: number; incomeAccountId: number | null }> {
  const existing = await findVehicleByPlate(plate);
  if (existing) return { id: existing.id, incomeAccountId: existing.incomeAccountId };

  // Vehicle type comes straight from Zarve's own category.engineType field on the
  // invoice's vehicle -- no name-keyword guessing needed.
  const incomeAccountId =
    vehicleType === "ev" ? settings.defaultIncomeAccountEvId : settings.defaultIncomeAccountFuelId;

  const [result] = await pool.query(
    "INSERT INTO vehicles (plate_number, name, category, income_account_id) VALUES (?, ?, ?, ?)",
    [normalizePlate(plate), name || plate, vehicleType, incomeAccountId]
  );
  return { id: (result as any).insertId, incomeAccountId };
}

interface SyncOutcome {
  totalRows: number;
  totalInvoices: number;
  totalSkipped: number;
  totalPayments: number;
  warnings: string[];
  periodInfo: string;
  previewRows?: ZarveSyncRow[];
}

/**
 * Posts every DAILY invoice already pulled into the local Zarve mirror (see
 * zarveMirrorSync.ts) to our own accounting ledger -- no month picker: it looks at
 * everything the mirror has up to today and, per booking, groups by calendar month
 * (matching a normal monthly billing cycle) so each month still becomes its own
 * invoice. Already-posted (partner, vehicle, month) combinations are skipped via the
 * same idempotency key the old Excel importer used, so re-running this after a fresh
 * mirror sync only posts what's actually new.
 *
 * Capped at today: Zarve pre-generates DAILY invoices for a booking's entire remaining
 * contract length, not just days that have actually happened (verified live -- most
 * long-running bookings have DAILY rows dated years out, unpaid because that day
 * hasn't occurred yet). Posting those would recognize revenue/receivables for rental
 * days that haven't happened, so only invoices dated today or earlier are posted.
 */
async function runSync(dryRun: boolean): Promise<SyncOutcome> {
  const today = new Date().toISOString().slice(0, 10);
  const [invoices, companies] = await Promise.all([
    fetchMirrorInvoices({ type: "DAILY", endDate: today }),
    getMirrorCompanies(),
  ]);
  const companyNames = new Map(companies.map((c) => [c.id, c.name]));
  const rows = buildSyncRows(invoices, companyNames);
  const months = Array.from(new Set(rows.map((r) => r.month))).sort();
  const periodInfo = months.length
    ? months.length === 1
      ? formatPeriodId(months[0])
      : `${formatPeriodId(months[0])} - ${formatPeriodId(months[months.length - 1])}`
    : "-";

  if (dryRun) {
    return { totalRows: rows.length, totalInvoices: 0, totalSkipped: 0, totalPayments: 0, warnings: [], periodInfo, previewRows: rows };
  }

  const warnings: string[] = [];
  let totalInvoices = 0;
  let totalSkipped = 0;
  let totalPayments = 0;

  const settings = await getSettings();
  const fallbackIncomeAccountId = await getAccountIdByCode(WELL_KNOWN_ACCOUNTS.DEFAULT_RENTAL_INCOME);

  // Sequential -- findOrCreatePartner/Vehicle and the invoice-number generator are not
  // safe under concurrent writes (same constraint as the old Excel importer).
  for (const row of rows) {
    try {
      const invoiceDate = `${row.month}-01`;
      const nik = /^\d{16}$/.test(row.nik) ? row.nik : null;
      const partner = await findOrCreatePartner(row.driverName, nik);
      const vehicle = await findOrCreateVehicle(row.vehicleName, row.vehiclePlate, row.vehicleType, settings);

      const existingInvoice = await findInvoiceByKey(partner.id, vehicle.id, invoiceDate);
      if (existingInvoice) {
        // Not logged as a warning -- since posting now runs against everything (not one
        // picked month), most rows on any re-run are expected already-posted skips, not
        // something worth surfacing individually. `totalSkipped` already summarizes it.
        totalSkipped++;
        continue;
      }

      if (row.totalBill > 0) {
        const invoice = await createInvoice({
          partnerId: partner.id,
          vehicleId: vehicle.id,
          invoiceDate,
          ref: normalizePlate(row.vehiclePlate),
          lines: [
            {
              description: `Sewa ${row.vehicleName} (${row.vehiclePlate}) - ${formatPeriodId(row.month)}`,
              category: "DAILY",
              accountId: vehicle.incomeAccountId ?? fallbackIncomeAccountId,
              amount: row.totalBill,
              taxRate: settings.ppnEnabled ? settings.ppnRate : 0,
            },
          ],
        });
        totalInvoices++;

        if (settings.autoCreatePayment) {
          for (const [dayStr, amount] of Object.entries(row.dailyAmounts)) {
            const day = Number(dayStr);
            const payDate = `${row.month}-${String(day).padStart(2, "0")}`;
            await createPayment({
              partnerId: partner.id,
              invoiceId: invoice.id,
              amount,
              date: payDate,
              method: "zarve-sync",
              memo: `Setoran ${row.vehiclePlate} / ${payDate}`,
            });
            totalPayments++;
          }
        }
      }

      warnings.push(...row.warnings.map((w) => `${row.vehiclePlate} (${row.driverName}, ${row.month}): ${w}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${row.vehiclePlate} (${row.driverName}, ${row.month}): GAGAL -- ${message}`);
    }
  }

  return { totalRows: rows.length, totalInvoices, totalSkipped, totalPayments, warnings, periodInfo };
}

/** Runs the posting step and records it in `import_batches` -- shared by the manual
 * "Konfirmasi Posting" button and the nightly scheduler (see scheduler.ts). */
export async function runZarveSyncAndLog(): Promise<SyncOutcome & { batchId: number }> {
  const result = await runSync(false);
  const [insertResult] = await pool.query(
    "INSERT INTO import_batches (file_name, period_info, total_rows, total_invoices, total_payments, state, error_log) VALUES (?, ?, ?, ?, ?, 'done', ?)",
    [`Posting Pembukuan dari Zarve`, result.periodInfo, result.totalRows, result.totalInvoices, result.totalPayments, result.warnings.join("\n") || null]
  );
  return { batchId: (insertResult as any).insertId, ...result };
}

export const zarveSyncController = {
  async preview(_req: Request, res: Response) {
    res.json(await runSync(true));
  },

  async run(_req: Request, res: Response) {
    const result = await runZarveSyncAndLog();
    res.status(201).json(result);
  },

  async history(_req: Request, res: Response) {
    const [rows] = await pool.query("SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 100");
    res.json(rows);
  },
};
