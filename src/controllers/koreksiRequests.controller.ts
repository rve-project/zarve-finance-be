import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { KOREKSI_RESOURCE_TYPES, KoreksiResourceType } from "../utils/periodLock";

/**
 * Permintaan Koreksi -- the escape hatch for Tutup Buku (see utils/periodLock.ts). A
 * user whose write got blocked (HTTP 423, period closed) files one of these instead;
 * once an approver grants it, the exact same write is retried and consumed
 * automatically by assertPeriodOpen -- this controller itself never touches a journal
 * entry or any ledger table.
 */

function mapRow(row: any) {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestedDate: row.requested_date,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at,
    rejectedReason: row.rejected_reason,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

export const koreksiRequestsController = {
  async list(req: Request, res: Response) {
    const canSeeAll = !!req.authUser!.canApproveCorrections;
    const clauses: string[] = ["kr.business_unit = ?"];
    const params: unknown[] = [req.businessUnit];
    if (!canSeeAll) {
      clauses.push("kr.requested_by = ?");
      params.push(req.authUser!.id);
    }
    const [rows] = await pool.query(
      `SELECT kr.*, ru.name AS requested_by_name, au.name AS approved_by_name
       FROM koreksi_requests kr
       LEFT JOIN users ru ON ru.id = kr.requested_by
       LEFT JOIN users au ON au.id = kr.approved_by
       WHERE ${clauses.join(" AND ")}
       ORDER BY kr.created_at DESC, kr.id DESC`,
      params
    );
    res.json((rows as any[]).map(mapRow));
  },

  async create(req: Request, res: Response) {
    const { resourceType, resourceId, requestedDate, reason } = req.body;
    if (!KOREKSI_RESOURCE_TYPES.includes(resourceType)) throw new ApiError(400, "Jenis transaksi tidak valid");
    if (!requestedDate) throw new ApiError(400, "Tanggal transaksi wajib diisi");
    if (!reason || !String(reason).trim()) throw new ApiError(400, "Alasan wajib diisi");

    // MySQL can't enforce a partial unique index on (resource_type, resource_id,
    // requested_date, status='pending_approval'), so this is checked at the app level --
    // acceptable for a low-volume, human-reviewed approval queue.
    const [dupRows] = await pool.query(
      `SELECT id FROM koreksi_requests
       WHERE business_unit = ? AND resource_type = ? AND resource_id <=> ? AND requested_date = ? AND status = 'pending_approval'`,
      [req.businessUnit, resourceType, resourceId ?? null, requestedDate]
    );
    if ((dupRows as any[]).length) throw new ApiError(400, "Sudah ada permintaan koreksi yang menunggu persetujuan untuk transaksi ini");

    const [result] = await pool.query(
      `INSERT INTO koreksi_requests (business_unit, resource_type, resource_id, requested_date, reason, requested_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.businessUnit, resourceType as KoreksiResourceType, resourceId ?? null, requestedDate, String(reason).trim(), req.authUser!.id]
    );
    const [rows] = await pool.query("SELECT * FROM koreksi_requests WHERE id = ?", [(result as any).insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },

  async approve(req: Request, res: Response) {
    if (!req.authUser!.canApproveCorrections) throw new ApiError(403, "Anda tidak punya akses untuk menyetujui permintaan koreksi");
    const [rows] = await pool.query("SELECT * FROM koreksi_requests WHERE id = ?", [req.params.id]);
    const request = (rows as any[])[0];
    if (!request || request.business_unit !== req.businessUnit) throw new ApiError(404, "Permintaan koreksi tidak ditemukan");
    if (request.status !== "pending_approval") throw new ApiError(400, "Hanya permintaan yang menunggu persetujuan yang bisa disetujui");

    await pool.query("UPDATE koreksi_requests SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?", [
      req.authUser!.id,
      request.id,
    ]);
    const [updated] = await pool.query("SELECT * FROM koreksi_requests WHERE id = ?", [request.id]);
    res.json(mapRow((updated as any[])[0]));
  },

  async reject(req: Request, res: Response) {
    if (!req.authUser!.canApproveCorrections) throw new ApiError(403, "Anda tidak punya akses untuk menolak permintaan koreksi");
    const [rows] = await pool.query("SELECT * FROM koreksi_requests WHERE id = ?", [req.params.id]);
    const request = (rows as any[])[0];
    if (!request || request.business_unit !== req.businessUnit) throw new ApiError(404, "Permintaan koreksi tidak ditemukan");
    if (request.status !== "pending_approval") throw new ApiError(400, "Hanya permintaan yang menunggu persetujuan yang bisa ditolak");

    await pool.query("UPDATE koreksi_requests SET status = 'rejected', rejected_reason = ? WHERE id = ?", [
      req.body.reason || null,
      request.id,
    ]);
    const [updated] = await pool.query("SELECT * FROM koreksi_requests WHERE id = ?", [request.id]);
    res.json(mapRow((updated as any[])[0]));
  },
};
