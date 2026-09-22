import { ZarveInvoice } from "./zarveApiClient";

// Same grouping idea as driverRevenueRecap.ts (group a period's DAILY invoices by
// bookingId into one row per driver tenure) but shaped for posting to our own
// accounting ledger instead of for on-screen/Excel display: bill/paid totals for the
// period instead of a per-day cell array, and a resolved vehicle name/type instead of
// just a plate. Kept separate from driverRevenueRecap.ts on purpose -- the two features
// read the same Zarve data but serve different consumers (a display pivot vs a ledger
// posting), and forcing one shared shape would make both harder to read for a change
// that saves ~15 lines.
export type SyncVehicleType = "ev" | "fuel";

export interface ZarveSyncRow {
  bookingId: string;
  month: string;
  driverName: string;
  nik: string;
  vehicleName: string;
  vehiclePlate: string;
  vehicleType: SyncVehicleType;
  collector: string;
  totalBill: number;
  totalPaid: number;
  /** day-of-month -> amount paid that day, only days with a non-zero payment. */
  dailyAmounts: Record<number, number>;
  warnings: string[];
}

function toNumber(v: string | number): number {
  return typeof v === "number" ? v : Number(v) || 0;
}

// "Listrik" (electric) vs everything else (Bensin/Solar/Hybrid) -- same mapping used
// for the Beranda dashboard's EV/Bensin split, verified against live /categories data.
function engineTypeToVehicleType(engineType: string | null | undefined): SyncVehicleType {
  return engineType === "Listrik" ? "ev" : "fuel";
}

/**
 * Group DAILY invoices from Zarve into one row per (vehicle, driver tenure, calendar
 * month) -- the same shape the old Excel importer's rows had (one accounting invoice
 * per booking per month), so each row can be posted to the ledger through the exact
 * same partner/vehicle/invoice/payment logic. `invoices` can span many months at once;
 * each month still becomes its own row/invoice, matching a normal monthly billing cycle.
 */
export function buildSyncRows(invoices: ZarveInvoice[], companyNames: Map<string, string>): ZarveSyncRow[] {
  const groups = new Map<string, ZarveSyncRow>();

  for (const inv of invoices) {
    const dateStr = inv.localDate ?? inv.date.slice(0, 10);
    const month = dateStr.slice(0, 7);
    const day = Number(dateStr.slice(8, 10));

    const vehicle = inv.booking?.vehicle;
    const driver = inv.booking?.driver;
    if (!inv.bookingId || !vehicle?.plateNumber) continue;

    const key = `${inv.bookingId}:${month}`;
    let row = groups.get(key);
    if (!row) {
      row = {
        bookingId: inv.bookingId,
        month,
        driverName: driver?.name?.trim() ?? "",
        nik: (driver?.nik ?? "").trim(),
        vehicleName: vehicle.category?.name?.trim() || vehicle.plateNumber,
        vehiclePlate: vehicle.plateNumber,
        vehicleType: engineTypeToVehicleType(vehicle.category?.engineType),
        collector: (inv.booking && companyNames.get(inv.booking.companyId)) ?? "",
        totalBill: 0,
        totalPaid: 0,
        dailyAmounts: {},
        warnings: [],
      };
      groups.set(key, row);
    }

    row.totalBill += toNumber(inv.total);
    const paid = toNumber(inv.amountPaid);
    row.totalPaid += paid;
    if (paid > 0) row.dailyAmounts[day] = (row.dailyAmounts[day] ?? 0) + paid;
  }

  const rows = Array.from(groups.values());
  for (const row of rows) {
    if (!row.driverName) row.warnings.push("Nama driver kosong di data Zarve, baris tetap diproses.");
    if (!/^\d{16}$/.test(row.nik)) {
      row.warnings.push(`NIK '${row.nik || "-"}' tidak valid (harus 16 angka) -- driver dicocokkan tanpa NIK.`);
    }
  }

  rows.sort((a, b) => a.month.localeCompare(b.month) || a.vehiclePlate.localeCompare(b.vehiclePlate));
  return rows;
}
