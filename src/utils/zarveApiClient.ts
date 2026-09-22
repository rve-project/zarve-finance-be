import { env } from "../config/env";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { cached } from "./ttlCache";

const TEN_MINUTES = 10 * 60 * 1000;

// Read-only client for the client's existing "Zarve" operational system (the same
// backend zarve-fe talks to). Used by the Revenue Recap feature to pull live DAILY
// invoice data directly, instead of requiring a manual Excel export/upload.
//
// Auth: the token is whatever Zarve's own /auth/login last handed back to a user
// logging into rve-finance (see auth.controller.ts's zarveLogin() call) -- persisted
// in app_settings and refreshed automatically on every login, so it never needs to be
// hand-copied into .env. Cached in memory for the life of the process; updated
// in-place the moment a fresh one is captured.

let cachedToken: string | null | undefined; // undefined = not loaded from DB yet

async function loadTokenFromDb(): Promise<string | null> {
  const [rows] = await pool.query("SELECT zarve_api_token FROM app_settings WHERE id = 1");
  const row = (rows as { zarve_api_token: string | null }[])[0];
  return row?.zarve_api_token ?? null;
}

async function getZarveApiToken(): Promise<string | null> {
  if (cachedToken === undefined) cachedToken = await loadTokenFromDb();
  return cachedToken;
}

export async function setZarveApiToken(token: string): Promise<void> {
  cachedToken = token;
  // NOW() resolves in the DB server's own system timezone (not necessarily UTC --
  // confirmed different between local dev and production), so compute "now" in JS
  // instead to keep this column reliably UTC everywhere.
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await pool.query("UPDATE app_settings SET zarve_api_token = ?, zarve_api_token_updated_at = ? WHERE id = 1", [token, now]);
}

interface ZarveEnvelope<T> {
  status: number;
  success: boolean;
  message: string;
  data: T;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The Zarve API isn't fully consistent about envelope shape: most endpoints nest
// pagination inside `data` (see ZarveInvoicesPage), but /vehicle-status-histories puts
// total/page/hasMore at the top level instead. zarveGetRaw returns the whole parsed
// body so each caller can unwrap whichever shape its endpoint actually uses.
//
// Retries on raw network failures (connect timeouts happen intermittently against
// this API, verified empirically) -- but NOT on a clean HTTP error response (4xx/5xx
// with a real body), which is retried zero times since retrying won't fix a 401/404.
async function zarveGetRaw<T extends { success: boolean; message?: string }>(
  path: string,
  params?: Record<string, string | number | undefined>,
  attempt = 1
): Promise<T> {
  if (!env.zarveApi.baseUrl) throw new ApiError(500, "ZARVE_API_URL belum diset di .env");
  const token = await getZarveApiToken();
  if (!token) {
    throw new ApiError(
      500,
      "Belum ada token Zarve API tersimpan -- minta salah satu user login ke rve-finance dulu (token diambil otomatis dari login)."
    );
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const query = qs.toString();
  const url = `${env.zarveApi.baseUrl}${path}${query ? `?${query}` : ""}`;

  const MAX_ATTEMPTS = 3;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      await delay(300 * attempt);
      return zarveGetRaw<T>(path, params, attempt + 1);
    }
    throw new ApiError(
      502,
      `Tidak bisa menghubungi Zarve API setelah ${MAX_ATTEMPTS}x percobaan (${path}). Coba lagi sebentar -- ini biasanya koneksi yang lambat, bukan masalah data.`
    );
  }

  const body = (await res.json().catch(() => null)) as T | null;

  if (!res.ok || !body?.success) {
    const message = body?.message || `Zarve API error (${res.status})`;
    if (res.status === 401) {
      throw new ApiError(
        502,
        `Token Zarve API sudah tidak valid/expired -- minta salah satu user login ulang ke rve-finance supaya token-nya ke-refresh. (${message})`
      );
    }
    throw new ApiError(502, `Gagal mengambil data dari Zarve API: ${message}`);
  }

  return body!;
}

async function zarveGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const body = await zarveGetRaw<ZarveEnvelope<T>>(path, params);
  return body.data;
}

export interface ZarveLoginUser {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive?: boolean;
  isSuspended?: boolean;
}

// Lets rve-finance delegate its own login to Zarve's account system, so staff use one
// set of credentials -- see auth.controller.ts. Deliberately bypasses zarveGetRaw: this
// call carries the end user's own email/password, not the service-level ZARVE_API_TOKEN.
// Returns null for a plain wrong-password rejection (caller reports "invalid
// credentials"); throws ApiError(502) only when Zarve itself is unreachable/erroring,
// so the two failure modes stay distinguishable to the end user.
export async function zarveLogin(email: string, password: string): Promise<{ user: ZarveLoginUser; token: string } | null> {
  if (!env.zarveApi.baseUrl) throw new ApiError(500, "ZARVE_API_URL belum diset di .env");

  let res: Response;
  try {
    res = await fetch(`${env.zarveApi.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new ApiError(502, "Tidak bisa menghubungi Zarve API untuk login. Coba lagi sebentar.");
  }

  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    message?: string;
    data?: { user: ZarveLoginUser; token: string };
  } | null;

  if (res.status === 401 || res.status === 400) return null;
  if (!res.ok || !body?.success || !body.data) {
    throw new ApiError(502, `Zarve API sedang tidak bisa diakses: ${body?.message ?? res.status}`);
  }
  return body.data;
}

export interface ZarveDriver {
  id: string;
  name: string;
  phoneNumber?: string | null;
  nik?: string | null;
}

export interface ZarveVehicle {
  id: string;
  plateNumber: string;
  category?: { id: string; name: string; engineType?: string } | null;
}

export interface ZarveBooking {
  id: string;
  orderNumber: string;
  companyId: string;
  endDate?: string | null;
  status?: string;
  driver?: ZarveDriver;
  vehicle?: ZarveVehicle;
}

export interface ZarveInvoiceItem {
  id: string;
  type?: string | null;
  status?: string | null;
  description: string;
  qty: number;
  price: string | number;
  subtotal: string | number;
}

export interface ZarveInvoice {
  id: string;
  invoiceNumber?: string;
  bookingId: string;
  date: string;
  localDate?: string;
  type: string;
  total: string | number;
  amountPaid: string | number;
  totalItems?: number;
  totalDiscount?: string | number;
  status: string;
  paymentMethod?: string | null;
  paidAt?: string | null;
  paymentTimeliness?: string;
  lateDays?: number;
  createdAt?: string;
  items?: ZarveInvoiceItem[];
  booking?: ZarveBooking;
}

export interface ZarveInvoicesPage {
  total: number;
  page: number;
  limit: number;
  data: ZarveInvoice[];
}

export interface InvoiceListParams {
  page?: number;
  limit?: number;
  status?: string;
  type?: string;
  search?: string;
  driverIds?: string;
  startDate?: string;
  endDate?: string;
}

/** One page of invoices, whatever filters the caller passes through as-is -- used by
 * the Invoice list page (paginated UI), as opposed to getDailyInvoices which loops
 * every page for the Revenue Recap's own internal aggregation. */
export async function getInvoicesPage(params: InvoiceListParams): Promise<ZarveInvoicesPage> {
  return zarveGet<ZarveInvoicesPage>("/invoices", { ...params, limit: params.limit ?? 20, page: params.page ?? 1 });
}

export async function getInvoiceDetail(id: string): Promise<ZarveInvoice> {
  return zarveGet<ZarveInvoice>(`/invoices/${id}`);
}

export interface ZarveInvoiceType {
  id: string;
  code: string;
  name: string;
  description?: string;
  isActive: boolean;
}

export async function getInvoiceTypes(): Promise<ZarveInvoiceType[]> {
  return cached("zarve:invoice-types", TEN_MINUTES, () => zarveGet<ZarveInvoiceType[]>("/invoice-types"));
}

export interface ZarveCompany {
  id: string;
  name: string;
  code?: string;
}

export async function getCompanies(): Promise<ZarveCompany[]> {
  return zarveGet<ZarveCompany[]>("/companies/all");
}

export interface ZarveCategory {
  id: string;
  name: string;
  companyId: string;
  engineType?: string | null;
  company?: { id: string; name: string };
}

// Fleet/category lists barely change day to day -- cache them so switching the "Type
// Unit" filter back and forth, or just re-opening the page, doesn't re-fetch every time.
export async function getCategories(): Promise<ZarveCategory[]> {
  return cached("zarve:categories", TEN_MINUTES, () => zarveGet<ZarveCategory[]>("/categories", { limit: 500 }));
}

export interface VehicleModelGroup {
  /** Stable key derived from the base model name -- pass this back as `categoryId` on
   * the recap endpoints; the group is recomputed from the live category list each time
   * rather than cached, so it always reflects whatever categories currently exist. */
  key: string;
  label: string;
  categoryIds: string[];
  companyNames: string[];
}

/** Strip a trailing "(RVE 1)" / "(SVA 2)" / "(BALI)" style fleet-batch suffix, leaving
 * just the car model name (e.g. "Vinfast VFe34 (RVE 3)" -> "Vinfast VFe34"). */
function baseModelName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * The Zarve fleet is registered as many separate "categories" per car model -- one
 * per batch/ownership group (RVE/SVA/IVA + number) -- even though they're the same
 * vehicle. Group them by base model name so a "Type Unit" picker shows one option per
 * actual car model, covering every batch's vehicles at once.
 */
export function groupCategoriesByModel(categories: ZarveCategory[]): VehicleModelGroup[] {
  const groups = new Map<string, VehicleModelGroup>();
  for (const c of categories) {
    const base = baseModelName(c.name);
    const key = base.toLowerCase().replace(/\s+/g, " ");
    let group = groups.get(key);
    if (!group) {
      group = { key, label: base, categoryIds: [], companyNames: [] };
      groups.set(key, group);
    }
    group.categoryIds.push(c.id);
    const companyName = c.company?.name;
    if (companyName && !group.companyNames.includes(companyName)) group.companyNames.push(companyName);
  }
  return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export interface ZarveVehicleListItem {
  id: string;
  plateNumber: string;
  categoryId: string;
  companyId: string;
}

// NOTE: the live API's `categoryId` query param on /vehicles is silently ignored (it
// returns every vehicle regardless) -- verified empirically. Callers filter client-side
// (see zarveMirror.ts's getMirrorVehicles() consumers) instead of relying on it.
export async function getAllVehicles(): Promise<ZarveVehicleListItem[]> {
  return cached("zarve:vehicles", TEN_MINUTES, () => zarveGet<ZarveVehicleListItem[]>("/vehicles", { limit: 1000 }));
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Firing dozens of
 * concurrent requests at the Zarve API causes connection timeouts (verified
 * empirically -- 57 parallel requests failed ~75% of the time), so anything that
 * fans out per-vehicle (like status history) must go through this.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type ZarveVehicleStatus = "AVAILABLE" | "RENTED" | "HOLD" | "MAINTENANCE" | string;

export interface ZarveVehicleStatusHistory {
  id: string;
  vehicleId: string;
  status: ZarveVehicleStatus;
  note: string | null;
  bookingId: string | null;
  driverId: string | null;
  createdAt: string;
}

interface ZarvePaginatedTop<T> {
  success: boolean;
  message?: string;
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  data: T[];
}

/** Full status-change timeline for one vehicle, oldest first. */
export async function getVehicleStatusHistory(vehicleId: string): Promise<ZarveVehicleStatusHistory[]> {
  const all: ZarveVehicleStatusHistory[] = [];
  let page = 1;

  while (true) {
    const result = await zarveGetRaw<ZarvePaginatedTop<ZarveVehicleStatusHistory>>("/vehicle-status-histories", {
      vehicleId,
      page,
      limit: 200,
    });
    all.push(...result.data);
    if (!result.hasMore || result.data.length === 0) break;
    page++;
  }

  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return all;
}

/** Status history for many vehicles at once, throttled to avoid overwhelming the API. */
export async function getVehicleStatusHistories(vehicleIds: string[]): Promise<Map<string, ZarveVehicleStatusHistory[]>> {
  const pairs = await mapWithConcurrency(vehicleIds, 5, async (id): Promise<[string, ZarveVehicleStatusHistory[]]> => [
    id,
    await getVehicleStatusHistory(id),
  ]);
  return new Map(pairs);
}

// "Keluar kota" tracking: a vehicle leaving its assigned working-area geofence gets an
// automatic fee (see /working-area/violations). Zarve only records the moment it was
// caught OUTSIDE (detectedAt) -- when/whether it came back has to be reconstructed from
// that vehicle's raw GPS position history (see getReturnTime below).
export interface ZarveGeofenceViolation {
  id: string;
  violationDate: string;
  detectedAt: string;
  latitude: number | null;
  longitude: number | null;
  price: string | number;
  status: string;
  invoiceId: string | null;
  imeiNumber: string | null;
  vehicle: { id: string; plateNumber: string } | null;
  geofence: { id: string; name: string } | null;
  driver: { id: string; name: string; phoneNumber?: string | null } | null;
  booking: { id: string; orderNumber: string | null } | null;
  invoice: { invoiceNumber: string | null; status: string } | null;
}

interface ZarvePaginatedMeta<T> {
  success: boolean;
  message?: string;
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean };
}

/** Every geofence violation ever recorded -- the live total is small (a couple hundred
 * at most, verified empirically), so no date filtering is needed to keep this cheap. */
export async function getAllGeofenceViolations(): Promise<ZarveGeofenceViolation[]> {
  const all: ZarveGeofenceViolation[] = [];
  let page = 1;
  const limit = 200;

  while (true) {
    const result = await zarveGetRaw<ZarvePaginatedMeta<ZarveGeofenceViolation>>("/working-area/violations", { page, limit });
    all.push(...result.data);
    if (!result.meta.hasMore || result.data.length === 0) break;
    page++;
  }

  return all;
}

export interface ZarveGpsHistoryPoint {
  timestamp: string;
  geofenceStatus?: string | null;
}

/** Raw GPS trail for one device on one local (Asia/Jakarta) calendar date -- can be
 * empty if that device's history isn't retained, which is a real, observed case (not
 * every unit's GPS type keeps history), not a bug to work around. */
async function getGpsHistory(imei: string, date: string): Promise<ZarveGpsHistoryPoint[]> {
  const result = await zarveGet<{ points: ZarveGpsHistoryPoint[] }>(`/gps-positions/history/${encodeURIComponent(imei)}`, { date });
  return result.points ?? [];
}

/**
 * First OUT -> IN geofence transition strictly after `detectedAt`, from that device's
 * GPS trail on the violation's own date -- i.e. "jam kembali". Returns null if the
 * device has no retained history, or if no return shows up the same day (still out
 * past midnight, or simply undetectable from this data).
 */
export async function getReturnTime(imei: string, violationDate: string, detectedAt: string): Promise<string | null> {
  const points = await getGpsHistory(imei, violationDate);
  const detectedMs = new Date(detectedAt).getTime();

  let wasOut = true; // at detectedAt the vehicle is (by definition) OUT
  for (const p of points) {
    const ts = new Date(p.timestamp).getTime();
    if (ts <= detectedMs) continue;
    const status = (p.geofenceStatus ?? "").toUpperCase();
    if (status === "IN" && wasOut) return p.timestamp;
    if (status === "OUT" || status === "IN") wasOut = status === "OUT";
  }
  return null;
}

/** Return times for many violations at once, throttled like the status-history fan-out.
 * Result is aligned to `violations` by index (not a map keyed by anything derived from
 * the violation, since two violations for the same vehicle on the same day are
 * possible and shouldn't collide). */
export async function getReturnTimes(
  violations: { id: string; imeiNumber: string | null; violationDate: string; detectedAt: string }[]
): Promise<Map<string, string | null>> {
  const pairs = await mapWithConcurrency(violations, 5, async (v): Promise<[string, string | null]> => {
    if (!v.imeiNumber) return [v.id, null];
    const returnedAt = await getReturnTime(v.imeiNumber, v.violationDate, v.detectedAt).catch(() => null);
    return [v.id, returnedAt];
  });
  return new Map(pairs);
}
