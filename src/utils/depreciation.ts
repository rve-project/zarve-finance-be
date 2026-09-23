/**
 * Straight-line depreciation math shared by the fixed-asset list (book value),
 * disposal (gain/loss), and the depreciation-schedule tab (this period's amount).
 * Month-based, not day-based -- matches the "Masa Manfaat: N Tahun" whole-month
 * convention the create form uses.
 */

export interface DepreciationInput {
  acquisitionDate: string;
  acquisitionCost: number;
  isNonDepreciating: boolean;
  usefulLifeYears: number | null;
  openingAccumulatedDepreciation: number;
}

/** The single source of truth for which methods this app can actually compute --
 * the create-asset form's Metode dropdown is populated from this (via
 * GET /fixed-assets/depreciation-methods) instead of a hardcoded frontend string, so
 * a new method only needs to be added here (with matching calc logic) to show up. */
export const SUPPORTED_DEPRECIATION_METHODS = ["straight_line"] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Whole months between two ISO dates, floor'd, never negative. */
function monthsBetween(from: string, to: string): number {
  const a = new Date(from);
  const b = new Date(to);
  const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0);
  return Math.max(0, months);
}

export function monthlyDepreciation(asset: DepreciationInput): number {
  if (asset.isNonDepreciating || !asset.usefulLifeYears || asset.usefulLifeYears <= 0) return 0;
  return round2(asset.acquisitionCost / (asset.usefulLifeYears * 12));
}

/** Accumulated depreciation and book value as of a given date (defaults to today). */
export function computeDepreciation(asset: DepreciationInput, asOf: string = new Date().toISOString().slice(0, 10)) {
  const monthly = monthlyDepreciation(asset);
  const monthsElapsed = monthsBetween(asset.acquisitionDate, asOf);
  const accumulatedFromSchedule = monthly * monthsElapsed;
  const accumulatedDepreciation = Math.min(
    asset.acquisitionCost,
    round2(asset.openingAccumulatedDepreciation + accumulatedFromSchedule)
  );
  const bookValue = round2(asset.acquisitionCost - accumulatedDepreciation);
  return {
    monthlyDepreciation: monthly,
    accumulatedDepreciation,
    bookValue,
    fullyDepreciated: !asset.isNonDepreciating && accumulatedDepreciation >= asset.acquisitionCost,
  };
}

/** This period's depreciation amount for the schedule tab -- the lesser of a full
 * month's depreciation or whatever's left before the asset is fully depreciated,
 * given the accumulated depreciation as of the day before the period starts. */
export function periodDepreciation(asset: DepreciationInput, periodStart: string): number {
  const monthly = monthlyDepreciation(asset);
  if (monthly <= 0) return 0;
  const dayBefore = new Date(periodStart);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const { accumulatedDepreciation } = computeDepreciation(asset, dayBefore.toISOString().slice(0, 10));
  const remaining = round2(asset.acquisitionCost - accumulatedDepreciation);
  return Math.max(0, Math.min(monthly, remaining));
}
