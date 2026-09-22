import { Request, Response } from "express";
import * as XLSX from "xlsx";
import { ApiError } from "../middlewares/errorHandler";
import { fetchMirrorInvoices, getMirrorCompanies } from "../utils/zarveMirror";
import { buildRevenueRecap } from "../utils/revenueRecap";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "27 Jul" -- matches the reference Excel's date column header style (no year, no leading zero). */
function formatDateColumnHeader(isoDate: string): string {
  const [, m, d] = isoDate.split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1].slice(0, 3)}`;
}

/**
 * "Payment Report - July 2026" when the whole range sits in one month (matches the
 * reference Excel exactly); falls back to an explicit range for multi-month exports.
 */
function buildTitle(startDate: string, endDate: string): string {
  const [sy, sm] = startDate.split("-");
  const [ey, em] = endDate.split("-");
  if (sy === ey && sm === em) {
    return `Payment Report - ${MONTH_NAMES[Number(sm) - 1]} ${sy}`;
  }
  return `Payment Report - ${startDate} s/d ${endDate}`;
}

async function loadRecap(startDate: string, endDate: string) {
  const [invoices, companies] = await Promise.all([
    fetchMirrorInvoices({ startDate, endDate, type: "DAILY" }),
    getMirrorCompanies(),
  ]);
  const companyNames = new Map(companies.map((c) => [c.id, c.name]));
  return buildRevenueRecap(invoices, companyNames, startDate, endDate);
}

function requireDates(req: Request): { startDate: string; endDate: string } {
  const startDate = req.query.startDate as string;
  const endDate = req.query.endDate as string;
  if (!startDate || !endDate) throw new ApiError(400, "startDate dan endDate wajib diisi (format YYYY-MM-DD)");
  return { startDate, endDate };
}

export const revenueRecapController = {
  async get(req: Request, res: Response) {
    const { startDate, endDate } = requireDates(req);
    const recap = await loadRecap(startDate, endDate);
    res.json(recap);
  },

  async export(req: Request, res: Response) {
    const { startDate, endDate } = requireDates(req);
    const recap = await loadRecap(startDate, endDate);

    const header = [
      "No",
      "Driver",
      "NIK",
      "Vehicle",
      "Vehicle Plate",
      "Collector Name",
      "End Date",
      "Status",
      "Total Bill",
      "Total Paid",
      "Total Unpaid",
      ...recap.dateColumns.map(formatDateColumnHeader),
    ];

    const rows = recap.rows.map((r, i) => [
      i + 1,
      r.driver,
      r.nik,
      r.vehicle,
      r.vehiclePlate,
      r.collector,
      r.endDate,
      r.status,
      r.totalBill,
      r.totalPaid,
      r.totalUnpaid,
      ...recap.dateColumns.map((d) => r.dailyAmounts[d] ?? ""),
    ]);

    const sheetData = [[buildTitle(startDate, endDate)], header, ...rows];

    const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Revenue Recap");

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Revenue Recap ${startDate} - ${endDate}.xlsx"`);
    res.send(buffer);
  },
};
