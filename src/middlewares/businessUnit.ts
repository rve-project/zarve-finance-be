import { NextFunction, Request, Response } from "express";
import { BusinessUnit } from "../models/types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      businessUnit: BusinessUnit;
    }
  }
}

/** Reads which business unit (Zarve or B2B) a request is scoped to from the
 * `X-Business-Unit` header the frontend attaches on every call (see api.ts). Defaults
 * to "zarve" on a missing/invalid header rather than rejecting the request, so every
 * endpoint that doesn't care about business units (auth, invoices, vehicles, etc.)
 * keeps working exactly as before, and any external caller that never sends the header
 * still gets sane Zarve-scoped behavior. */
export function resolveBusinessUnit(req: Request, _res: Response, next: NextFunction) {
  req.businessUnit = req.headers["x-business-unit"] === "b2b" ? "b2b" : "zarve";
  next();
}
