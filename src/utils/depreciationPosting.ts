import { pool } from "../db";
import { postJournalEntry } from "./ledger";
import { periodDepreciation } from "./depreciation";
import { BusinessUnit } from "../models/types";

/** "YYYY-MM" -> the next calendar month, also "YYYY-MM". */
function nextMonth(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" -> that month's last day, "YYYY-MM-DD" -- depreciation posts as of
 * month-end, the standard convention. */
function lastDayOfMonth(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${period}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

export interface DepreciationPostingResult {
  posted: { assetId: number; assetName: string; period: string; amount: number }[];
  skipped: { assetId: number; assetName: string; reason: string }[];
}

/**
 * Catches up every (asset, month) pair from each active depreciating asset's
 * acquisition month through `throughMonth` (inclusive) that's due (periodDepreciation
 * > 0) but not yet in fixed_asset_depreciation_postings, posting one journal entry per
 * period (Debit depreciation expense, Credit accumulated depreciation) dated at that
 * month's last day.
 *
 * Shared by two callers (same dual pattern as syncAndPost() in scheduler.ts for the
 * Zarve mirror): the nightly cron in scheduler.ts, which runs this automatically for
 * every business unit, and the "Jalankan Penyusutan" button
 * (POST /fixed-assets/run-depreciation), kept for an on-demand/immediate run -- e.g.
 * right after fixing a misconfigured asset, without waiting for the next cron tick.
 */
export async function runDueDepreciation(businessUnit: BusinessUnit, throughMonth?: string): Promise<DepreciationPostingResult> {
  const through = throughMonth || new Date().toISOString().slice(0, 7);

  const [rows] = await pool.query(
    "SELECT * FROM fixed_assets WHERE business_unit = ? AND status = 'active' AND is_non_depreciating = FALSE",
    [businessUnit]
  );
  const assets = (rows as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    assetNumber: r.asset_number,
    acquisitionDate: r.acquisition_date as string,
    acquisitionCost: Number(r.acquisition_cost),
    usefulLifeYears: r.useful_life_years === null ? null : Number(r.useful_life_years),
    openingAccumulatedDepreciation: Number(r.opening_accumulated_depreciation),
    depreciationExpenseAccountId: r.depreciation_expense_account_id as number | null,
    accumulatedDepreciationAccountId: r.accumulated_depreciation_account_id as number | null,
  }));

  const posted: DepreciationPostingResult["posted"] = [];
  const skipped: DepreciationPostingResult["skipped"] = [];

  for (const asset of assets) {
    if (!asset.depreciationExpenseAccountId || !asset.accumulatedDepreciationAccountId) {
      skipped.push({ assetId: asset.id, assetName: asset.name, reason: "Akun beban/akumulasi penyusutan belum diisi" });
      continue;
    }

    const [postedRows] = await pool.query("SELECT period FROM fixed_asset_depreciation_postings WHERE fixed_asset_id = ?", [asset.id]);
    const alreadyPosted = new Set((postedRows as any[]).map((r) => r.period as string));

    let month = asset.acquisitionDate.slice(0, 7);
    while (month <= through) {
      if (!alreadyPosted.has(month)) {
        const amount = periodDepreciation(
          {
            acquisitionDate: asset.acquisitionDate,
            acquisitionCost: asset.acquisitionCost,
            isNonDepreciating: false,
            usefulLifeYears: asset.usefulLifeYears,
            openingAccumulatedDepreciation: asset.openingAccumulatedDepreciation,
          },
          `${month}-01`
        );
        if (amount > 0) {
          const journalEntryId = await postJournalEntry({
            date: lastDayOfMonth(month),
            ref: `PENYUSUTAN-${asset.assetNumber}-${month}`,
            narration: `Penyusutan ${asset.name} periode ${month}`,
            sourceType: "manual",
            businessUnit,
            lines: [
              { accountId: asset.depreciationExpenseAccountId, debit: amount, credit: 0 },
              { accountId: asset.accumulatedDepreciationAccountId, debit: 0, credit: amount },
            ],
          });
          await pool.query(
            "INSERT INTO fixed_asset_depreciation_postings (fixed_asset_id, period, amount, journal_entry_id) VALUES (?, ?, ?, ?)",
            [asset.id, month, amount, journalEntryId]
          );
          posted.push({ assetId: asset.id, assetName: asset.name, period: month, amount });
        }
      }
      month = nextMonth(month);
    }
  }

  return { posted, skipped };
}
