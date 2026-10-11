import cron from "node-cron";
import { syncZarveMirror, isSyncRunning, setSyncLogPhase } from "./utils/zarveMirrorSync";
import { runZarveSyncAndLog } from "./controllers/zarveSync.controller";
import { runDueDepreciation } from "./utils/depreciationPosting";

// Nightly, at 02:00 server time -- outside business hours, so a ~10-15 minute mirror
// pull doesn't compete with anyone actively using the app.
const SCHEDULE = "0 2 * * *";

// 02:30 WIB -- right after the Zarve sync above, same off-hours reasoning. Runs daily
// (not just on the 1st) so it keeps catching up even if the server was down right at
// month-end; posting is idempotent (fixed_asset_depreciation_postings), so running it
// every night costs nothing once a month's depreciation is already posted.
const DEPRECIATION_SCHEDULE = "30 2 * * *";

/**
 * Pulls everything from Zarve, then immediately posts whatever's new to the ledger --
 * one action, not two. Both the nightly cron below and the manual "Sinkronkan
 * Sekarang" button call this same function, so a manual run behaves exactly like the
 * scheduled one instead of requiring a separate "preview -> confirm posting" step.
 * Fire-and-forget from the caller's side -- the frontend watches progress via
 * GET /zarve-mirror/status (phase text updates through both the mirror and posting
 * steps on the same log row) rather than waiting on this promise.
 */
export async function syncAndPost() {
  if (await isSyncRunning()) {
    console.log("[sync] Sinkronisasi sedang berjalan, lewati permintaan ini.");
    return;
  }

  console.log("[sync] Mulai sinkronisasi Zarve...");
  let mirrorResult;
  try {
    mirrorResult = await syncZarveMirror();
    console.log(
      `[sync] Sync mirror selesai: ${mirrorResult.totalInvoices} invoice, ${mirrorResult.totalVehicles} kendaraan (${Math.round(mirrorResult.durationMs / 1000)}s).`
    );
  } catch (err) {
    console.error("[sync] Sync mirror gagal, posting ke pembukuan dilewati:", err);
    return;
  }

  try {
    await setSyncLogPhase(mirrorResult.logId, "Posting ke pembukuan...");
    const postResult = await runZarveSyncAndLog();
    console.log(
      `[sync] Posting ke pembukuan selesai: ${postResult.totalInvoices} invoice baru, ${postResult.totalPayments} payment baru, ${postResult.totalSkipped} dilewati.`
    );
    await setSyncLogPhase(
      mirrorResult.logId,
      `Selesai. Posting ke pembukuan: ${postResult.totalInvoices} invoice baru, ${postResult.totalPayments} payment baru, ${postResult.totalSkipped} dilewati.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync] Posting ke pembukuan gagal:", err);
    await setSyncLogPhase(mirrorResult.logId, `Sync selesai, tapi posting ke pembukuan GAGAL: ${message}`);
  }
}

/**
 * Posts every active depreciating asset's due-but-unposted depreciation, for both
 * business units -- fixed_assets is a B2B-only feature today, but looping both is
 * harmless (an empty result) and means this doesn't silently need revisiting if Zarve
 * ever starts tracking its own fixed assets this way.
 */
async function postDueDepreciation() {
  console.log("[depreciation] Memeriksa penyusutan yang jatuh tempo...");
  for (const businessUnit of ["b2b", "zarve"] as const) {
    try {
      const result = await runDueDepreciation(businessUnit);
      if (result.posted.length || result.skipped.length) {
        console.log(
          `[depreciation] (${businessUnit}) ${result.posted.length} jurnal penyusutan diposting, ${result.skipped.length} aset dilewati.`
        );
      }
    } catch (err) {
      console.error(`[depreciation] (${businessUnit}) Gagal memposting penyusutan:`, err);
    }
  }
}

export function startScheduler() {
  // Explicit timezone -- without it, node-cron reads "02:00" against the server's OWN
  // system clock, which isn't WIB on every box this runs on (confirmed: the staging
  // host's system tz is UTC+8, and the production Docker container defaults to UTC,
  // so "02:00" was actually firing at 01:00 WIB and 09:00 WIB respectively -- the
  // latter is smack in business hours, not the empty-night window this is meant for).
  cron.schedule(SCHEDULE, syncAndPost, { timezone: "Asia/Jakarta" });
  console.log(`[scheduler] Sinkronisasi Zarve otomatis dijadwalkan setiap hari jam 02:00 WIB (cron: "${SCHEDULE}").`);

  cron.schedule(DEPRECIATION_SCHEDULE, postDueDepreciation, { timezone: "Asia/Jakarta" });
  console.log(`[scheduler] Penyusutan aset otomatis dijadwalkan setiap hari jam 02:30 WIB (cron: "${DEPRECIATION_SCHEDULE}").`);
}
