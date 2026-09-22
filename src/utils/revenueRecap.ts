import { ZarveInvoice } from "./zarveApiClient";

export interface RecapRow {
  bookingId: string;
  orderNumber: string;
  driver: string;
  nik: string;
  vehicle: string;
  vehiclePlate: string;
  collector: string;
  endDate: string;
  status: string;
  totalBill: number;
  totalPaid: number;
  totalUnpaid: number;
  dailyAmounts: Record<string, number>;
}

export interface RevenueRecap {
  from: string;
  to: string;
  dateColumns: string[];
  rows: RecapRow[];
  grandTotalBill: number;
  grandTotalPaid: number;
  grandTotalUnpaid: number;
}

function toNumber(v: string | number): number {
  return typeof v === "number" ? v : Number(v) || 0;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format an ISO datetime as "DD Mon YYYY" (matches the reference Excel's End Date column). */
function formatEndDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Terminal booking states read as "exit" (contract ended); everything else (still
// ongoing/pending) reads as "active" -- matches the active/exit values seen in the
// reference Excel's Status column.
const TERMINAL_STATUSES = new Set(["COMPLETED", "CANCELLED"]);

function deriveStatus(bookingStatus: string | undefined): string {
  if (!bookingStatus) return "active";
  return TERMINAL_STATUSES.has(bookingStatus) ? "exit" : "active";
}

function invoiceDateKey(inv: ZarveInvoice): string {
  // localDate is already YYYY-MM-DD in the client's timezone; `date` is a UTC
  // timestamp that can land on the previous day when converted naively -- prefer
  // localDate when present.
  return inv.localDate ?? inv.date.slice(0, 10);
}

/**
 * Group live DAILY invoices from the Zarve API into the same pivot shape as the
 * client's "Operasional - Order" Excel export (one row per driver+vehicle booking,
 * one column per day) -- see plan doc for why: daily columns = amount paid that day,
 * Total Bill/Paid/Unpaid = the period summary.
 */
export function buildRevenueRecap(
  invoices: ZarveInvoice[],
  companyNames: Map<string, string>,
  from: string,
  to: string
): RevenueRecap {
  const groups = new Map<string, RecapRow>();
  const dateSet = new Set<string>();

  for (const inv of invoices) {
    const booking = inv.booking;
    const dateKey = invoiceDateKey(inv);
    dateSet.add(dateKey);

    let row = groups.get(inv.bookingId);
    if (!row) {
      row = {
        bookingId: inv.bookingId,
        orderNumber: booking?.orderNumber ?? "",
        driver: booking?.driver?.name ?? "",
        nik: (booking?.driver?.nik ?? "").trim(),
        vehicle: booking?.vehicle?.category?.name ?? "",
        vehiclePlate: booking?.vehicle?.plateNumber ?? "",
        collector: (booking && companyNames.get(booking.companyId)) ?? "",
        endDate: formatEndDate(booking?.endDate),
        status: deriveStatus(booking?.status),
        totalBill: 0,
        totalPaid: 0,
        totalUnpaid: 0,
        dailyAmounts: {},
      };
      groups.set(inv.bookingId, row);
    }

    const bill = toNumber(inv.total);
    const paid = toNumber(inv.amountPaid);
    row.totalBill += bill;
    row.totalPaid += paid;
    row.dailyAmounts[dateKey] = (row.dailyAmounts[dateKey] ?? 0) + paid;
  }

  const rows = Array.from(groups.values()).map((r) => ({ ...r, totalUnpaid: r.totalBill - r.totalPaid }));
  // Matches the reference Excel's row order: grouped by Collector Name, then
  // alphabetical by Driver within each collector group.
  rows.sort((a, b) => a.collector.localeCompare(b.collector) || a.driver.localeCompare(b.driver));

  const dateColumns = Array.from(dateSet).sort();

  return {
    from,
    to,
    dateColumns,
    rows,
    grandTotalBill: rows.reduce((s, r) => s + r.totalBill, 0),
    grandTotalPaid: rows.reduce((s, r) => s + r.totalPaid, 0),
    grandTotalUnpaid: rows.reduce((s, r) => s + r.totalUnpaid, 0),
  };
}
