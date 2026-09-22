import { pool } from "../db";
import { ZarveCategory, ZarveCompany, ZarveVehicleListItem, ZarveInvoice, ZarveVehicleStatusHistory } from "./zarveApiClient";

/** `detected_at`/`returned_at` are stored as naive "YYYY-MM-DD HH:MM:SS" (mysql2's
 * dateStrings mode) that actually hold a UTC instant (see toMysqlDateTime in
 * zarveMirrorSync.ts) -- reformat to a real ISO string with "Z" before this ever
 * reaches the API response, so `new Date(...)` on the frontend parses it as UTC
 * instead of silently defaulting to the browser's own timezone. */
export function toUtcIso(naive: string | null): string | null {
  if (!naive) return null;
  return `${naive.replace(" ", "T")}Z`;
}

export interface MirrorGeofenceViolation {
  id: string;
  vehicleId: string;
  /** "YYYY-MM-DD" */
  violationDate: string;
  detectedAt: string;
  returnedAt: string | null;
  geofenceName: string | null;
  price: number;
  status: string;
}

// Read side of the local Zarve mirror (see zarveMirrorSync.ts for the write side).
// Every function here reconstructs the exact same shapes zarveApiClient's live calls
// used to return, so the existing pure builders (driverRevenueRecap.ts, revenueRecap.ts)
// and their consumers don't need to change at all -- only where the data comes from does.

export async function getMirrorCompanies(): Promise<ZarveCompany[]> {
  const [rows] = await pool.query("SELECT * FROM zarve_companies");
  return (rows as any[]).map((r) => ({ id: r.id, name: r.name, code: r.code ?? undefined }));
}

export async function getMirrorCategories(): Promise<ZarveCategory[]> {
  const [rows] = await pool.query(
    "SELECT zc.*, comp.name AS company_name FROM zarve_categories zc LEFT JOIN zarve_companies comp ON comp.id = zc.company_id"
  );
  return (rows as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    companyId: r.company_id,
    engineType: r.engine_type,
    company: r.company_id ? { id: r.company_id, name: r.company_name } : undefined,
  }));
}

export async function getMirrorVehicles(): Promise<ZarveVehicleListItem[]> {
  const [rows] = await pool.query("SELECT * FROM zarve_vehicles");
  return (rows as any[]).map((r) => ({
    id: r.id,
    plateNumber: r.plate_number,
    categoryId: r.category_id,
    companyId: r.company_id,
  }));
}

export interface MirrorInvoiceFilter {
  startDate?: string;
  endDate?: string;
  vehicleIds?: string[];
  type?: string;
}

export function mapMirrorInvoiceRow(r: any): ZarveInvoice {
  return {
    id: r.id,
    invoiceNumber: r.invoice_number ?? undefined,
    bookingId: r.booking_id,
    date: r.invoice_date,
    localDate: r.invoice_date,
    type: r.type,
    total: r.total,
    amountPaid: r.amount_paid,
    totalDiscount: r.total_discount,
    status: r.status,
    paymentMethod: r.payment_method,
    paidAt: toUtcIso(r.paid_at),
    paymentTimeliness: r.payment_timeliness,
    lateDays: r.late_days,
    createdAt: toUtcIso(r.created_at_zarve) ?? undefined,
    booking: {
      id: r.booking_id,
      orderNumber: r.order_number ?? "",
      companyId: r.company_id,
      endDate: r.booking_end_date,
      status: r.booking_status,
      driver: {
        id: r.driver_id ?? "",
        name: r.driver_name ?? "",
        phoneNumber: r.driver_phone,
        nik: r.driver_nik,
      },
      vehicle: {
        id: r.vehicle_id ?? "",
        plateNumber: r.vehicle_plate ?? "",
        category: { id: "", name: r.vehicle_category_name ?? "", engineType: r.vehicle_engine_type ?? undefined },
      },
    },
  };
}

export async function fetchMirrorInvoices(filter: MirrorInvoiceFilter): Promise<ZarveInvoice[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.startDate) {
    clauses.push("invoice_date >= ?");
    params.push(filter.startDate);
  }
  if (filter.endDate) {
    clauses.push("invoice_date <= ?");
    params.push(filter.endDate);
  }
  if (filter.type) {
    clauses.push("type = ?");
    params.push(filter.type);
  }
  if (filter.vehicleIds?.length) {
    clauses.push(`vehicle_id IN (${filter.vehicleIds.map(() => "?").join(",")})`);
    params.push(...filter.vehicleIds);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [rows] = await pool.query(`SELECT * FROM zarve_invoices ${where} ORDER BY invoice_date`, params);
  return (rows as any[]).map(mapMirrorInvoiceRow);
}

/** Geofence violations ("keluar kota") for the given vehicles in a date range,
 * grouped by vehicle id -- used by the Driver Revenue Recap to flag which day cells
 * had a vehicle leave its working area. */
export async function fetchMirrorGeofenceViolations(
  vehicleIds: string[],
  startDate: string,
  endDate: string
): Promise<Map<string, MirrorGeofenceViolation[]>> {
  const map = new Map<string, MirrorGeofenceViolation[]>();
  if (!vehicleIds.length) return map;
  const [rows] = await pool.query(
    `SELECT * FROM zarve_geofence_violations
     WHERE vehicle_id IN (${vehicleIds.map(() => "?").join(",")}) AND violation_date BETWEEN ? AND ?
     ORDER BY vehicle_id, violation_date`,
    [...vehicleIds, startDate, endDate]
  );
  for (const r of rows as any[]) {
    const v: MirrorGeofenceViolation = {
      id: r.id,
      vehicleId: r.vehicle_id,
      violationDate: r.violation_date,
      detectedAt: toUtcIso(r.detected_at)!,
      returnedAt: toUtcIso(r.returned_at),
      geofenceName: r.geofence_name,
      price: Number(r.price),
      status: r.status,
    };
    if (!map.has(r.vehicle_id)) map.set(r.vehicle_id, []);
    map.get(r.vehicle_id)!.push(v);
  }
  return map;
}

export async function fetchMirrorVehicleStatusHistories(vehicleIds: string[]): Promise<Map<string, ZarveVehicleStatusHistory[]>> {
  const map = new Map<string, ZarveVehicleStatusHistory[]>();
  if (!vehicleIds.length) return map;
  const [rows] = await pool.query(
    `SELECT * FROM zarve_vehicle_status_histories WHERE vehicle_id IN (${vehicleIds.map(() => "?").join(",")}) ORDER BY vehicle_id, created_at_zarve`,
    vehicleIds
  );
  for (const r of rows as any[]) {
    const h: ZarveVehicleStatusHistory = {
      id: r.id,
      vehicleId: r.vehicle_id,
      status: r.status,
      note: r.note,
      bookingId: r.booking_id,
      driverId: r.driver_id,
      createdAt: r.created_at_zarve,
    };
    if (!map.has(r.vehicle_id)) map.set(r.vehicle_id, []);
    map.get(r.vehicle_id)!.push(h);
  }
  return map;
}
