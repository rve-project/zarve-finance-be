import { PoolConnection } from "mysql2/promise";
import { ApiError } from "../middlewares/errorHandler";
import { BusinessUnit } from "../models/types";
import { getSettings } from "./settings";

/** Every place in the app a koreksi_request can reference. Centralized here so the 4
 * write-paths that call assertPeriodOpen and koreksiRequests.controller.ts can't drift
 * out of sync on the string values. */
export const KOREKSI_RESOURCE_TYPES = [
  "journal_entry",
  "expense",
  "fixed_asset_revaluation",
  "sale_invoice_approval",
  "purchase_invoice_approval",
] as const;
export type KoreksiResourceType = (typeof KOREKSI_RESOURCE_TYPES)[number];

/**
 * Tutup Buku enforcement. A transaction dated more than `periodLockDays` days ago can no
 * longer write to the ledger -- unless an approved, not-yet-used `koreksi_requests` row
 * exists for this exact (business_unit, resource_type, resource_id, date), in which case
 * it's consumed here and the write proceeds.
 *
 * MUST be called with the same `conn` (an open transaction) as the write it's guarding,
 * and the caller must not have committed yet. The approval is claimed atomically --
 * `UPDATE ... WHERE used_at IS NULL` -- in that same transaction, so (a) two concurrent
 * writes can never consume one approval twice, and (b) if the write fails later and the
 * transaction rolls back, the claim rolls back with it instead of being burned for
 * nothing. `resourceId` may be null (a manual journal entry doesn't exist yet when its
 * correction request is filed) -- `<=>` is MySQL's null-safe equality, so a NULL
 * `resource_id` column only matches a NULL `resourceId` argument, never a real id.
 */
export async function assertPeriodOpen(params: {
  conn: PoolConnection;
  businessUnit: BusinessUnit;
  resourceType: KoreksiResourceType;
  resourceId: number | null;
  date: string;
}): Promise<void> {
  const { conn, businessUnit, resourceType, resourceId, date } = params;
  const settings = await getSettings();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - settings.periodLockDays);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  if (date.slice(0, 10) >= cutoffIso) return; // still within the open window -- no lock to clear

  const [result] = await conn.query(
    `UPDATE koreksi_requests
       SET used_at = NOW()
     WHERE business_unit = ? AND resource_type = ? AND resource_id <=> ? AND requested_date = ?
       AND status = 'approved' AND used_at IS NULL
     LIMIT 1`,
    [businessUnit, resourceType, resourceId, date.slice(0, 10)]
  );
  if ((result as any).affectedRows !== 1) {
    throw new ApiError(
      423,
      `Periode ${date.slice(0, 10)} sudah ditutup (tutup buku, maksimal ${settings.periodLockDays} hari ke belakang). Ajukan permintaan koreksi terlebih dahulu.`
    );
  }
}
