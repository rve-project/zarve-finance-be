import { pool } from "../db";

// Mirrors what `edw_rental_import`'s `rental.import.config` configured per-company in
// the old Odoo setup, adapted to this app's data source (live Zarve sync, not an Excel
// upload -- so vehicle EV/fuel classification comes straight from Zarve's own
// category.engineType field, not name-keyword guessing): per-category default income
// accounts, and whether the sync should also auto-create payment records.
export interface AppSettings {
  defaultIncomeAccountEvId: number | null;
  defaultIncomeAccountFuelId: number | null;
  autoCreatePayment: boolean;
  /** PPN (Indonesian VAT) on new invoices -- off by default. Applying tax
   * unconditionally would misstate the books for a business that isn't PKP
   * (VAT-registered); this stays off until that's confirmed and turned on here. */
  ppnEnabled: boolean;
  ppnRate: number;
}

export interface UpdateSettingsInput {
  defaultIncomeAccountEvId?: number | null;
  defaultIncomeAccountFuelId?: number | null;
  autoCreatePayment?: boolean;
  ppnEnabled?: boolean;
  ppnRate?: number;
}

function mapRow(row: any): AppSettings {
  return {
    defaultIncomeAccountEvId: row.default_income_account_ev_id,
    defaultIncomeAccountFuelId: row.default_income_account_fuel_id,
    autoCreatePayment: !!row.auto_create_payment,
    ppnEnabled: !!row.ppn_enabled,
    ppnRate: Number(row.ppn_rate),
  };
}

// Read on every sync run but changed rarely -- cache in memory, same pattern as
// `getAccountIdByCode` in ledger.ts.
let cache: AppSettings | null = null;

export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache;
  const [rows] = await pool.query("SELECT * FROM app_settings WHERE id = 1");
  cache = mapRow((rows as any[])[0]);
  return cache;
}

export async function updateSettings(patch: UpdateSettingsInput): Promise<AppSettings> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.defaultIncomeAccountEvId !== undefined) {
    sets.push("default_income_account_ev_id = ?");
    params.push(patch.defaultIncomeAccountEvId);
  }
  if (patch.defaultIncomeAccountFuelId !== undefined) {
    sets.push("default_income_account_fuel_id = ?");
    params.push(patch.defaultIncomeAccountFuelId);
  }
  if (patch.autoCreatePayment !== undefined) {
    sets.push("auto_create_payment = ?");
    params.push(patch.autoCreatePayment ? 1 : 0);
  }
  if (patch.ppnEnabled !== undefined) {
    sets.push("ppn_enabled = ?");
    params.push(patch.ppnEnabled ? 1 : 0);
  }
  if (patch.ppnRate !== undefined) {
    sets.push("ppn_rate = ?");
    params.push(patch.ppnRate);
  }

  if (sets.length) {
    await pool.query(`UPDATE app_settings SET ${sets.join(", ")} WHERE id = 1`, params);
    cache = null;
  }

  return getSettings();
}
