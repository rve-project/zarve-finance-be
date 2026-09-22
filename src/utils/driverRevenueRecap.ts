import { ZarveInvoice, ZarveVehicleStatusHistory } from "./zarveApiClient";
import { MirrorGeofenceViolation } from "./zarveMirror";

export type RecapCellKind = "revenue" | "idle" | "maintenance" | "blank";

export interface DriverRecapCellViolation {
  detectedAt: string;
  returnedAt: string | null;
  geofenceName: string | null;
  price: number;
}

export interface DriverRecapCell {
  day: number;
  kind: RecapCellKind;
  amount?: number;
  note?: string;
  /** Only set on `revenue` cells: amount paid that day is less than that day's bill
   * (invoice.total) -- a partial payment, not a full day's rate. */
  partial?: boolean;
  /** Set regardless of `kind` -- a vehicle can leave its geofence on a day that still
   * has normal revenue, idle, or maintenance status; this is an overlay, not a
   * replacement for the day's actual state. */
  violation?: DriverRecapCellViolation;
}

export interface DriverRecapRow {
  vehiclePlate: string;
  driverName: string;
  nik: string;
  collector: string;
  vehicleType: "ev" | "fuel";
  cells: DriverRecapCell[];
  totalRevenue: number;
  /** Sum of `price` across this row's days with a geofence violation -- the billing
   * amount for the driver's out-of-town incidents that month. */
  totalKeluarKota: number;
}

export interface DriverRevenueRecap {
  month: string;
  daysInMonth: number;
  rows: DriverRecapRow[];
}

function toNumber(v: string | number): number {
  return typeof v === "number" ? v : Number(v) || 0;
}

function dayKey(month: string, day: number): string {
  const [y, m] = month.split("-");
  return `${y}-${m}-${String(day).padStart(2, "0")}`;
}

/** Status active on `date` (YYYY-MM-DD), per a vehicle's status-change timeline (oldest
 * first). The status from the most recent change at or before that date wins. */
// The live data uses both "MAINTENANCE" and "BENGKEL" ("workshop") for a vehicle
// being out of service -- confirmed by inspecting real vehicle-status-histories
// entries (e.g. "BENGKEL / Trouble Kampas Rem").
const MAINTENANCE_STATUSES = new Set(["MAINTENANCE", "BENGKEL"]);

function statusOnDate(history: ZarveVehicleStatusHistory[], date: string): ZarveVehicleStatusHistory | undefined {
  let current: ZarveVehicleStatusHistory | undefined;
  for (const h of history) {
    const changeDate = h.createdAt.slice(0, 10);
    if (changeDate <= date) current = h;
    else break;
  }
  return current;
}

interface BookingGroup {
  bookingId: string;
  driverName: string;
  nik: string;
  collector: string;
  dailyAmounts: Map<number, number>;
  dailyBills: Map<number, number>;
}

/**
 * Build the "REKAP REVENUE HARIAN DRIVER" pivot: one row per (vehicle, driver tenure)
 * -- a vehicle gets multiple consecutive rows if different drivers/bookings used it
 * during the month. Within a row: days before that tenure started are blank; days
 * within the tenure show that day's revenue (or "maintenance" if the vehicle's status
 * history says it was in the shop that day); days after the tenure's last invoice (up
 * to month end) show as "Unit Idle" filler for that row.
 */
export function buildDriverRevenueRecap(
  month: string,
  vehicles: { id: string; plateNumber: string; vehicleType: "ev" | "fuel" }[],
  invoicesByVehicle: Map<string, ZarveInvoice[]>,
  historyByVehicle: Map<string, ZarveVehicleStatusHistory[]>,
  companyNames: Map<string, string> = new Map(),
  violationsByVehicle: Map<string, MirrorGeofenceViolation[]> = new Map()
): DriverRevenueRecap {
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();

  const rows: DriverRecapRow[] = [];

  for (const vehicle of vehicles) {
    const invoices = invoicesByVehicle.get(vehicle.id) ?? [];
    const history = historyByVehicle.get(vehicle.id) ?? [];

    // Earliest violation wins on a day with more than one (rare) -- just need to flag
    // the day, not enumerate every violation on it.
    const violationByDay = new Map<number, MirrorGeofenceViolation>();
    for (const v of violationsByVehicle.get(vehicle.id) ?? []) {
      if (!v.violationDate.startsWith(month)) continue;
      const day = Number(v.violationDate.slice(8, 10));
      const existing = violationByDay.get(day);
      if (!existing || v.detectedAt < existing.detectedAt) violationByDay.set(day, v);
    }

    const groups = new Map<string, BookingGroup>();
    for (const inv of invoices) {
      const dateStr = inv.localDate ?? inv.date.slice(0, 10);
      if (!dateStr.startsWith(month)) continue;
      const day = Number(dateStr.slice(8, 10));

      let group = groups.get(inv.bookingId);
      if (!group) {
        group = {
          bookingId: inv.bookingId,
          driverName: inv.booking?.driver?.name ?? "",
          nik: (inv.booking?.driver?.nik ?? "").trim(),
          collector: (inv.booking && companyNames.get(inv.booking.companyId)) ?? "",
          dailyAmounts: new Map(),
          dailyBills: new Map(),
        };
        groups.set(inv.bookingId, group);
      }
      group.dailyAmounts.set(day, (group.dailyAmounts.get(day) ?? 0) + toNumber(inv.amountPaid));
      group.dailyBills.set(day, (group.dailyBills.get(day) ?? 0) + toNumber(inv.total));
    }

    const bookingGroups = Array.from(groups.values());
    bookingGroups.sort((a, b) => Math.min(...a.dailyAmounts.keys()) - Math.min(...b.dailyAmounts.keys()));

    for (const group of bookingGroups) {
      const days = Array.from(group.dailyAmounts.keys());
      const tenureStart = Math.min(...days);
      const tenureEnd = Math.max(...days);

      const cells: DriverRecapCell[] = [];
      for (let day = 1; day <= daysInMonth; day++) {
        if (day < tenureStart) {
          cells.push({ day, kind: "blank" });
          continue;
        }

        const v = violationByDay.get(day);
        const violation: DriverRecapCellViolation | undefined = v
          ? { detectedAt: v.detectedAt, returnedAt: v.returnedAt, geofenceName: v.geofenceName, price: v.price }
          : undefined;

        // Checked for both in-tenure and trailing-idle days: a vehicle can go into the
        // shop between two drivers' tenures too, not just mid-rental.
        const active = statusOnDate(history, dayKey(month, day));
        if (active && MAINTENANCE_STATUSES.has(active.status)) {
          cells.push({ day, kind: "maintenance", note: active.note ?? undefined, violation });
          continue;
        }

        if (day > tenureEnd) {
          cells.push({ day, kind: "idle", violation });
        } else {
          const amount = group.dailyAmounts.get(day) ?? 0;
          const bill = group.dailyBills.get(day) ?? 0;
          // amount === 0 reads as "Cuti / Tidak Masuk" (driver off that day) in the UI --
          // distinct from a partial payment, which is > 0 but short of that day's bill.
          const partial = amount > 0 && bill > 0 && amount < bill;
          cells.push({ day, kind: "revenue", amount, partial, violation });
        }
      }

      const totalRevenue = cells.reduce((sum, c) => sum + (c.kind === "revenue" ? c.amount ?? 0 : 0), 0);
      const totalKeluarKota = cells.reduce((sum, c) => sum + (c.violation?.price ?? 0), 0);

      rows.push({
        vehiclePlate: vehicle.plateNumber,
        driverName: group.driverName,
        nik: group.nik,
        collector: group.collector,
        vehicleType: vehicle.vehicleType,
        cells,
        totalRevenue,
        totalKeluarKota,
      });
    }
  }

  rows.sort((a, b) => a.vehiclePlate.localeCompare(b.vehiclePlate));

  return { month, daysInMonth, rows };
}
