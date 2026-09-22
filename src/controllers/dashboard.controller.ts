import { Request, Response } from "express";
import { pool } from "../db";

/** Status-count breakdown for the Beranda dashboard, read from the local Zarve mirror
 * (see zarveMirrorSync.ts) instead of live per-status API calls. */
export const dashboardController = {
  async invoiceStatusSummary(req: Request, res: Response) {
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (startDate) {
      clauses.push("invoice_date >= ?");
      params.push(startDate);
    }
    if (endDate) {
      clauses.push("invoice_date <= ?");
      params.push(endDate);
    } else {
      // Some vehicles have long-term lease bookings whose DAILY invoices are all
      // pre-generated up front, dated years ahead -- without an explicit end date,
      // exclude anything not yet due so it doesn't inflate "outstanding"/unpaid
      // totals with bills nobody could have paid yet.
      clauses.push("invoice_date <= CURDATE()");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [rows] = await pool.query(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS totalAmount, COALESCE(SUM(total - amount_paid), 0) AS outstandingAmount
       FROM zarve_invoices ${where} GROUP BY status`,
      params
    );
    res.json(
      (rows as any[]).map((r) => ({
        status: r.status,
        count: Number(r.count),
        totalAmount: Number(r.totalAmount),
        outstandingAmount: Number(r.outstandingAmount),
      }))
    );
  },
};
