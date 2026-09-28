import { NextFunction, Request, Response } from "express";
import { pool } from "../db";

/**
 * D'Consulting audit gap #10: a single global hook instead of touching every one of the
 * ~30 route files -- installed once in app.ts, right after resolveBusinessUnit and
 * before the API router. Only logs mutating requests from an authenticated user; `next()`
 * runs immediately (nothing here should ever slow down or fail a real request), and the
 * actual insert happens on `res.on("finish")`, by which point req.authUser is already
 * populated by whichever route's own requireAuth ran downstream.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SENSITIVE_FIELDS = new Set(["password", "passwordHash", "password_hash", "idToken", "token"]);

function sanitizeBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return null;
  const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const field of SENSITIVE_FIELDS) delete clone[field];
  return clone;
}

function resourceFromPath(path: string): { resourceType: string | null; resourceId: string | null } {
  const segments = path.split("/").filter(Boolean);
  const start = segments[0] === "api" ? 1 : 0;
  const resourceType = segments[start] ?? null;
  const resourceId = segments[start + 1] && /^\d+$/.test(segments[start + 1]) ? segments[start + 1] : null;
  return { resourceType, resourceId };
}

export function auditLog(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING_METHODS.has(req.method)) return next();

  res.on("finish", () => {
    if (!req.authUser) return;
    const { resourceType, resourceId } = resourceFromPath(req.path);
    pool
      .query(
        `INSERT INTO activity_logs (user_id, business_unit, method, path, resource_type, resource_id, request_body, response_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.authUser.id,
          req.businessUnit ?? null,
          req.method,
          req.originalUrl,
          resourceType,
          resourceId,
          JSON.stringify(sanitizeBody(req.body)),
          res.statusCode,
        ]
      )
      .catch((err) => console.error("auditLog insert failed:", err));
  });

  next();
}
