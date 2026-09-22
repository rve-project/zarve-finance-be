import { Request, Response } from "express";
import ExcelJS from "exceljs";
import { ApiError } from "../middlewares/errorHandler";
import { groupCategoriesByModel, ZarveInvoice } from "../utils/zarveApiClient";
import {
  getMirrorCategories,
  getMirrorVehicles,
  getMirrorCompanies,
  fetchMirrorInvoices,
  fetchMirrorVehicleStatusHistories,
  fetchMirrorGeofenceViolations,
} from "../utils/zarveMirror";
import { getLastSyncInfo } from "../utils/zarveMirrorSync";
import { buildDriverRevenueRecap, DriverRevenueRecap } from "../utils/driverRevenueRecap";

export const ALL_VEHICLES_KEY = "__all__";

function monthRange(month: string): { startDate: string; endDate: string } {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { startDate: `${month}-01`, endDate: `${month}-${String(lastDay).padStart(2, "0")}` };
}

interface RecapResult {
  recap: DriverRevenueRecap;
  categoryName: string;
  /** When the local mirror was last synced from Zarve -- lets the UI show the user how
   * stale what they're looking at is (data is served from our own DB, not live). */
  fetchedAt: string | null;
}

// "Listrik" (electric) vs everything else (Bensin/Solar/Hybrid) -- matches the original
// dashboard's "Kendaraan Listrik & Bensin" framing, which only ever split fleet revenue
// two ways. Verified against live /categories data: engineType is one of
// Listrik/Bensin/Solar/Hybrid.
function engineTypeToVehicleType(engineType: string | null | undefined): "ev" | "fuel" {
  return engineType === "Listrik" ? "ev" : "fuel";
}

async function loadRecap(modelKey: string, month: string): Promise<RecapResult> {
  const lastSync = await getLastSyncInfo();
  const fetchedAt = lastSync?.status === "done" ? lastSync.finishedAt : null;

  let vehicles: { id: string; plateNumber: string; categoryId: string }[];
  let categoryName: string;

  const categories = await getMirrorCategories();
  const categoryEngineTypeById = new Map(categories.map((c) => [c.id, c.engineType]));
  const allVehicles = await getMirrorVehicles();

  if (modelKey === ALL_VEHICLES_KEY) {
    vehicles = allVehicles;
    categoryName = "Semua Kendaraan";
  } else {
    const groups = groupCategoriesByModel(categories);
    const group = groups.find((g) => g.key === modelKey);
    if (!group) throw new ApiError(404, "Tipe unit (model kendaraan) tidak ditemukan");
    const idSet = new Set(group.categoryIds);
    vehicles = allVehicles.filter((v) => idSet.has(v.categoryId));
    categoryName = group.label;
  }

  const vehicleTypeById = new Map(
    vehicles.map((v) => [v.id, engineTypeToVehicleType(categoryEngineTypeById.get(v.categoryId))])
  );

  if (!vehicles.length) {
    return {
      recap: { month, daysInMonth: new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate(), rows: [] },
      categoryName,
      fetchedAt,
    };
  }

  const { startDate, endDate } = monthRange(month);
  const vehicleIds = vehicles.map((v) => v.id);

  const [allInvoices, historyByVehicle, companies, violationsByVehicle] = await Promise.all([
    fetchMirrorInvoices({ startDate, endDate, type: "DAILY", vehicleIds }),
    fetchMirrorVehicleStatusHistories(vehicleIds),
    getMirrorCompanies(),
    fetchMirrorGeofenceViolations(vehicleIds, startDate, endDate),
  ]);
  const companyNames = new Map(companies.map((c) => [c.id, c.name]));

  const vehicleIdSet = new Set(vehicleIds);
  const invoicesByVehicle = new Map<string, ZarveInvoice[]>();
  for (const inv of allInvoices) {
    const vId = inv.booking?.vehicle?.id;
    if (!vId || !vehicleIdSet.has(vId)) continue;
    if (!invoicesByVehicle.has(vId)) invoicesByVehicle.set(vId, []);
    invoicesByVehicle.get(vId)!.push(inv);
  }

  const recap = buildDriverRevenueRecap(
    month,
    vehicles.map((v) => ({ id: v.id, plateNumber: v.plateNumber, vehicleType: vehicleTypeById.get(v.id) ?? "fuel" })),
    invoicesByVehicle,
    historyByVehicle,
    companyNames,
    violationsByVehicle
  );

  return { recap, categoryName, fetchedAt };
}

function requireParams(req: Request): { categoryId: string; month: string } {
  const categoryId = req.query.categoryId as string;
  const month = req.query.month as string;
  if (!categoryId || !month) throw new ApiError(400, "categoryId dan month (format YYYY-MM) wajib diisi");
  return { categoryId, month };
}

const MONTH_NAMES_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

function formatPeriodId(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES_ID[m - 1]} ${y}`;
}

export const driverRevenueRecapController = {
  async categories(_req: Request, res: Response) {
    const categories = await getMirrorCategories();
    const groups = groupCategoriesByModel(categories);
    res.json([
      { id: ALL_VEHICLES_KEY, name: "Semua Kendaraan", companyName: "" },
      ...groups.map((g) => ({ id: g.key, name: g.label, companyName: g.companyNames.join(", ") })),
    ]);
  },

  async get(req: Request, res: Response) {
    const { categoryId, month } = requireParams(req);
    const { recap, categoryName, fetchedAt } = await loadRecap(categoryId, month);
    res.json({ ...recap, categoryName, fetchedAt });
  },

  async export(req: Request, res: Response) {
    const { categoryId, month } = requireParams(req);
    const { recap, categoryName } = await loadRecap(categoryId, month);

    const dayHeaders = Array.from({ length: recap.daysInMonth }, (_, i) => i + 1);
    const header = ["No", "Nama Driver", "Nopol", ...dayHeaders, "Jumlah Revenue", "Denda Keluar Kota"];

    const FILL = {
      idle: "FFFFF9C4" as const, // yellow -- unit idle (no driver assigned)
      maintenance: "FFFFCC80" as const, // orange/brown -- vehicle in the shop
      leave: "FFEF9A9A" as const, // red -- amount 0 = driver cuti / tidak masuk
      partial: "FF9E9D24" as const, // dark olive/brownish-green -- paid less than that day's bill
    };

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Rekap Revenue");

    sheet.mergeCells(1, 1, 1, header.length);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = "REKAP REVENUE HARIAN DRIVER";
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: "center" };

    sheet.mergeCells(2, 1, 2, header.length);
    const subtitleCell = sheet.getCell(2, 1);
    subtitleCell.value = `Tipe Unit: ${categoryName}  |  Periode: ${formatPeriodId(month)}`;
    subtitleCell.alignment = { horizontal: "center" };

    // Legend for the fill colors used on the day cells below -- otherwise a colored
    // cell with no header/caption is meaningless once this leaves the app (Excel has
    // no equivalent of the web page's on-screen legend row).
    const LEGEND: { fill: string; label: string }[] = [
      { fill: FILL.idle, label: "Unit Idle" },
      { fill: FILL.maintenance, label: "Maintenance" },
      { fill: FILL.leave, label: "Cuti / Tidak Masuk" },
      { fill: FILL.partial, label: "Bayar Sebagian" },
    ];
    let legendCol = 1;
    for (const item of LEGEND) {
      const swatch = sheet.getCell(3, legendCol);
      swatch.fill = { type: "pattern", pattern: "solid", fgColor: { argb: item.fill } };
      swatch.border = {
        top: { style: "thin", color: { argb: "FFBBBBBB" } },
        bottom: { style: "thin", color: { argb: "FFBBBBBB" } },
        left: { style: "thin", color: { argb: "FFBBBBBB" } },
        right: { style: "thin", color: { argb: "FFBBBBBB" } },
      };
      const label = sheet.getCell(3, legendCol + 1);
      label.value = item.label;
      label.font = { size: 9, italic: true };
      legendCol += 2;
    }
    sheet.mergeCells(3, legendCol, 3, legendCol + 3);
    const legendNote = sheet.getCell(3, legendCol);
    legendNote.value = "Sel dengan tanda komentar (pojok merah) = ada info keluar area kerja (geofence) -- arahkan kursor untuk detail";
    legendNote.font = { size: 9, italic: true, color: { argb: "FF666666" } };

    const headerRow = sheet.getRow(4);
    header.forEach((h, i) => {
      headerRow.getCell(i + 1).value = h;
    });
    headerRow.font = { bold: true };

    recap.rows.forEach((r, i) => {
      const excelRow = sheet.getRow(5 + i);
      excelRow.getCell(1).value = i + 1;
      excelRow.getCell(2).value = r.driverName;
      excelRow.getCell(3).value = r.vehiclePlate;

      r.cells.forEach((cell, ci) => {
        const col = 4 + ci; // after No, Nama Driver, Nopol
        const excelCell = excelRow.getCell(col);
        if (cell.kind === "blank") {
          excelCell.value = "";
        } else if (cell.kind === "idle") {
          excelCell.value = "Unit Idle";
          excelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL.idle } };
        } else if (cell.kind === "maintenance") {
          excelCell.value = cell.note ? `maintenance (${cell.note})` : "maintenance";
          excelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL.maintenance } };
        } else if (!cell.amount) {
          excelCell.value = 0;
          excelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL.leave } };
          excelCell.note = "Cuti / Tidak Masuk";
        } else if (cell.partial) {
          excelCell.value = cell.amount;
          excelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL.partial } };
          excelCell.font = { color: { argb: "FFFFFFFF" } };
        } else {
          excelCell.value = cell.amount;
        }

        if (cell.violation) {
          const out = new Date(cell.violation.detectedAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
          const back = cell.violation.returnedAt
            ? new Date(cell.violation.returnedAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" })
            : "belum terdeteksi kembali";
          const existingNote = typeof excelCell.note === "string" ? `${excelCell.note}\n` : "";
          excelCell.note = `${existingNote}Keluar area (${cell.violation.geofenceName ?? "geofence"}): ${out}\nKembali: ${back}`;
        }
      });

      excelRow.getCell(4 + r.cells.length).value = r.totalRevenue;
      excelRow.getCell(5 + r.cells.length).value = r.totalKeluarKota;
    });

    sheet.columns.forEach((col, i) => {
      col.width = i < 2 ? 22 : i === 2 ? 14 : 11;
    });

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Rekap Revenue Harian Driver - ${categoryName} - ${month}.xlsx"`
    );
    res.send(Buffer.from(buffer));
  },
};
