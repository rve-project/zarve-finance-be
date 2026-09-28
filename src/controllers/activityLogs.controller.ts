import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";

export const activityLogsController = {
  async list(req: Request, res: Response) {
    if (!req.authUser!.canViewActivityLog) throw new ApiError(403, "Anda tidak punya akses untuk melihat log aktivitas");

    const { userId, resourceType, from, to } = req.query;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 50;

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (userId) {
      clauses.push("al.user_id = ?");
      params.push(userId);
    }
    if (resourceType) {
      clauses.push("al.resource_type = ?");
      params.push(resourceType);
    }
    if (from) {
      clauses.push("al.created_at >= ?");
      params.push(`${from} 00:00:00`);
    }
    if (to) {
      clauses.push("al.created_at <= ?");
      params.push(`${to} 23:59:59`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [countRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM activity_logs al ${where}`, params);
    const total = (countRows as any[])[0].cnt as number;

    const [rows] = await pool.query(
      `SELECT al.*, u.name AS user_name, u.email AS user_email
       FROM activity_logs al LEFT JOIN users u ON u.id = al.user_id
       ${where} ORDER BY al.created_at DESC, al.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );

    res.json({
      total,
      page,
      limit,
      data: (rows as any[]).map((r) => ({
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        userEmail: r.user_email,
        businessUnit: r.business_unit,
        method: r.method,
        path: r.path,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        requestBody: r.request_body,
        responseStatus: r.response_status,
        createdAt: r.created_at,
      })),
    });
  },
};
