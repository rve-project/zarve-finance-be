import { PoolConnection } from "mysql2/promise";
import { pool } from "../db";
import {
  getCompanies,
  getCategories,
  getAllVehicles,
  getInvoicesPage,
  getVehicleStatusHistories,
  getAllGeofenceViolations,
  getReturnTimes,
  ZarveInvoice,
} from "./zarveApiClient";
import { invalidateCache } from "./ttlCache";
import { toUtcIso } from "./zarveMirror";

function toNumber(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return 0;
  return typeof v === "number" ? v : Number(v) || 0;
}

function invoiceDateOf(inv: ZarveInvoice): string {
  return inv.localDate ?? inv.date.slice(0, 10);
}

/** Zarve's DATETIME fields come as ISO 8601 ("2026-06-25T11:54:00.000Z") -- MySQL's
 * DATETIME columns reject the "T"/"Z"/milliseconds, so reformat to "YYYY-MM-DD HH:MM:SS"
 * (in UTC). Also used for "now" instead of SQL's NOW()/CURRENT_TIMESTAMP -- those
 * resolve in the DB server's OWN system timezone (confirmed different between local
 * dev, which happens to run UTC, and the production box, which runs UTC+8), so a
 * naive NOW() string isn't safely UTC everywhere. Computing "now" here in JS and
 * converting explicitly keeps every stored value UTC regardless of server tz. */
function toMysqlDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function nowMysqlDateTime(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Chunked `INSERT ... ON DUPLICATE KEY UPDATE`. Mirroring the full invoice history
 * (a couple hundred thousand rows) one `INSERT` per row would mean that many network
 * round-trips to MySQL -- batching cuts that down to a handful of statements.
 */
async function batchUpsert(
  conn: PoolConnection,
  table: string,
  columns: string[],
  rows: unknown[][],
  updateColumns: string[],
  chunkSize = 500
) {
  if (!rows.length) return;
  const updateClause = updateColumns.map((c) => `${c} = VALUES(${c})`).join(", ");
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await conn.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ? ON DUPLICATE KEY UPDATE ${updateClause}`,
      [chunk]
    );
  }
}

/** Fetch every invoice of every type, following pagination -- the Invoice menu needs
 * to browse all of them, not just DAILY rentals (see zarveInvoices.controller.ts). */
async function getAllInvoicesEver(): Promise<ZarveInvoice[]> {
  const all: ZarveInvoice[] = [];
  let page = 1;
  const limit = 1000;
  while (true) {
    const result = await getInvoicesPage({ page, limit });
    all.push(...result.data);
    if (all.length >= result.total || result.data.length === 0) break;
    page++;
  }
  return all;
}

export interface ZarveMirrorSyncResult {
  logId: number;
  totalCompanies: number;
  totalCategories: number;
  totalVehicles: number;
  totalInvoices: number;
  totalStatusHistories: number;
  durationMs: number;
}

/**
 * Pull everything from the live Zarve API and overwrite our local mirror tables with
 * it. Manually triggered (see zarveMirror.controller.ts) -- every display page reads
 * from these tables afterwards instead of calling Zarve live, so pages load instantly
 * regardless of how slow the Zarve API itself is. This is a genuinely long-running
 * operation (roughly 10-15 minutes, dominated by paging through ~240k invoices at
 * Zarve's own response time, not by anything on our side) -- that cost is paid once
 * per manual sync, not once per page view.
 */
async function setPhase(logId: number, phase: string) {
  await pool.query("UPDATE zarve_sync_log SET phase = ? WHERE id = ?", [phase, logId]);
}

/** Exposed so the posting step chained after this sync (see scheduler.ts) can keep
 * updating the same log row's phase text instead of the frontend losing progress
 * visibility the moment the mirror pull itself finishes. */
export async function setSyncLogPhase(logId: number, phase: string) {
  await setPhase(logId, phase);
}

export async function isSyncRunning(): Promise<boolean> {
  const [rows] = await pool.query("SELECT id FROM zarve_sync_log WHERE status = 'running' LIMIT 1");
  return (rows as any[]).length > 0;
}

export async function syncZarveMirror(): Promise<ZarveMirrorSyncResult> {
  const startedAtMs = Date.now();
  const [logResult] = await pool.query("INSERT INTO zarve_sync_log (started_at, status, phase) VALUES (?, 'running', 'Memulai...')", [
    nowMysqlDateTime(),
  ]);
  const logId = (logResult as any).insertId;

  try {
    // getCategories/getAllVehicles are TTL-cached for the sake of any leftover live
    // callers -- invalidate first so a sync always pulls genuinely fresh data instead
    // of whatever happened to be cached from up to 10 minutes ago.
    invalidateCache("zarve:categories");
    invalidateCache("zarve:vehicles");
    await setPhase(logId, "Mengambil data cabang, kategori & kendaraan...");
    const [companies, categories, vehicles] = await Promise.all([getCompanies(), getCategories(), getAllVehicles()]);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await batchUpsert(
        conn,
        "zarve_companies",
        ["id", "name", "code"],
        companies.map((c) => [c.id, c.name, c.code ?? null]),
        ["name", "code"]
      );

      await batchUpsert(
        conn,
        "zarve_categories",
        ["id", "name", "company_id", "engine_type"],
        categories.map((c) => [c.id, c.name, c.companyId ?? null, c.engineType ?? null]),
        ["name", "company_id", "engine_type"]
      );

      await batchUpsert(
        conn,
        "zarve_vehicles",
        ["id", "plate_number", "category_id", "company_id"],
        vehicles.map((v) => [v.id, v.plateNumber, v.categoryId ?? null, v.companyId ?? null]),
        ["plate_number", "category_id", "company_id"]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    await setPhase(logId, "Menarik seluruh riwayat invoice dari Zarve (bisa 10-15 menit)...");
    const invoices = await getAllInvoicesEver();

    await setPhase(logId, `Menyimpan ${invoices.length} invoice ke database lokal...`);

    const invoiceColumns = [
      "id", "invoice_number", "booking_id", "order_number", "company_id",
      "driver_id", "driver_name", "driver_nik", "driver_phone",
      "vehicle_id", "vehicle_plate", "vehicle_category_name", "vehicle_engine_type",
      "booking_end_date", "booking_status", "invoice_date", "type",
      "total", "amount_paid", "total_discount", "status",
      "payment_method", "paid_at", "payment_timeliness", "late_days", "created_at_zarve",
    ];
    const invoiceRows = invoices.map((inv) => {
      const booking = inv.booking;
      const driver = booking?.driver;
      const vehicle = booking?.vehicle;
      return [
        inv.id,
        inv.invoiceNumber ?? null,
        inv.bookingId,
        booking?.orderNumber ?? null,
        booking?.companyId ?? null,
        driver?.id ?? null,
        driver?.name ?? null,
        driver?.nik ?? null,
        driver?.phoneNumber ?? null,
        vehicle?.id ?? null,
        vehicle?.plateNumber ?? null,
        vehicle?.category?.name ?? null,
        vehicle?.category?.engineType ?? null,
        booking?.endDate ? booking.endDate.slice(0, 10) : null,
        booking?.status ?? null,
        invoiceDateOf(inv),
        inv.type,
        toNumber(inv.total),
        toNumber(inv.amountPaid),
        toNumber(inv.totalDiscount),
        inv.status,
        inv.paymentMethod ?? null,
        toMysqlDateTime(inv.paidAt),
        inv.paymentTimeliness ?? null,
        inv.lateDays ?? null,
        toMysqlDateTime(inv.createdAt),
      ];
    });
    const invoiceUpdateColumns = invoiceColumns.filter((c) => c !== "id");

    const invoiceConn = await pool.getConnection();
    try {
      await invoiceConn.beginTransaction();
      await batchUpsert(invoiceConn, "zarve_invoices", invoiceColumns, invoiceRows, invoiceUpdateColumns);
      await invoiceConn.commit();
    } catch (err) {
      await invoiceConn.rollback();
      throw err;
    } finally {
      invoiceConn.release();
    }

    await setPhase(logId, `Mengambil riwayat status ${vehicles.length} kendaraan...`);
    const historyByVehicle = await getVehicleStatusHistories(vehicles.map((v) => v.id));
    const historyRows: unknown[][] = [];
    for (const [vehicleId, histories] of historyByVehicle) {
      for (const h of histories) {
        historyRows.push([h.id, vehicleId, h.status, h.note ?? null, h.bookingId ?? null, h.driverId ?? null, toMysqlDateTime(h.createdAt)]);
      }
    }

    const historyConn = await pool.getConnection();
    try {
      await historyConn.beginTransaction();
      await batchUpsert(
        historyConn,
        "zarve_vehicle_status_histories",
        ["id", "vehicle_id", "status", "note", "booking_id", "driver_id", "created_at_zarve"],
        historyRows,
        ["status", "note", "booking_id", "driver_id", "created_at_zarve"]
      );
      await historyConn.commit();
    } catch (err) {
      await historyConn.rollback();
      throw err;
    } finally {
      historyConn.release();
    }

    await setPhase(logId, "Mengambil data pelanggaran geofence (keluar kota)...");
    const violations = await getAllGeofenceViolations();
    await setPhase(logId, `Menghitung jam kembali untuk ${violations.length} pelanggaran (dari riwayat GPS)...`);
    const returnTimes = await getReturnTimes(
      violations.map((v) => ({ id: v.id, imeiNumber: v.imeiNumber, violationDate: v.violationDate.slice(0, 10), detectedAt: v.detectedAt }))
    );

    const violationColumns = [
      "id", "violation_date", "detected_at", "returned_at", "latitude", "longitude", "price", "status",
      "vehicle_id", "vehicle_plate", "geofence_name", "driver_id", "driver_name", "booking_id",
      "invoice_id", "invoice_number", "imei_number",
    ];
    const violationRows = violations.map((v) => [
      v.id,
      v.violationDate.slice(0, 10),
      toMysqlDateTime(v.detectedAt),
      toMysqlDateTime(returnTimes.get(v.id) ?? null),
      v.latitude,
      v.longitude,
      toNumber(v.price),
      v.status,
      v.vehicle?.id ?? null,
      v.vehicle?.plateNumber ?? null,
      v.geofence?.name ?? null,
      v.driver?.id ?? null,
      v.driver?.name ?? null,
      v.booking?.id ?? null,
      v.invoiceId,
      v.invoice?.invoiceNumber ?? null,
      v.imeiNumber,
    ]);
    const violationUpdateColumns = violationColumns.filter((c) => c !== "id");

    const violationConn = await pool.getConnection();
    try {
      await violationConn.beginTransaction();
      await batchUpsert(violationConn, "zarve_geofence_violations", violationColumns, violationRows, violationUpdateColumns);
      await violationConn.commit();
    } catch (err) {
      await violationConn.rollback();
      throw err;
    } finally {
      violationConn.release();
    }

    const durationMs = Date.now() - startedAtMs;
    await pool.query(
      "UPDATE zarve_sync_log SET finished_at = ?, total_invoices = ?, total_vehicles = ?, total_status_histories = ?, status = 'done' WHERE id = ?",
      [nowMysqlDateTime(), invoices.length, vehicles.length, historyRows.length, logId]
    );

    return {
      logId,
      totalCompanies: companies.length,
      totalCategories: categories.length,
      totalVehicles: vehicles.length,
      totalInvoices: invoices.length,
      totalStatusHistories: historyRows.length,
      durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query("UPDATE zarve_sync_log SET finished_at = ?, status = 'error', error_message = ? WHERE id = ?", [
      nowMysqlDateTime(),
      message,
      logId,
    ]);
    throw err;
  }
}

export interface ZarveSyncLogEntry {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  phase: string | null;
  totalInvoices: number;
  totalVehicles: number;
  totalStatusHistories: number;
  status: string;
  errorMessage: string | null;
}

export async function getLastSyncInfo(): Promise<ZarveSyncLogEntry | null> {
  const [rows] = await pool.query("SELECT * FROM zarve_sync_log ORDER BY id DESC LIMIT 1");
  const row = (rows as any[])[0];
  if (!row) return null;
  return {
    id: row.id,
    startedAt: toUtcIso(row.started_at) as string,
    finishedAt: toUtcIso(row.finished_at),
    phase: row.phase,
    totalInvoices: row.total_invoices,
    totalVehicles: row.total_vehicles,
    totalStatusHistories: row.total_status_histories,
    status: row.status,
    errorMessage: row.error_message,
  };
}
