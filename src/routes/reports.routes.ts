import { Router } from "express";
import { reportsController } from "../controllers/reports.controller";
import { requireAuth } from "../middlewares/auth";

export const reportsRouter = Router();

reportsRouter.use(requireAuth);
reportsRouter.get("/trial-balance", reportsController.trialBalance);
reportsRouter.get("/general-ledger", reportsController.generalLedger);
reportsRouter.get("/profit-loss", reportsController.profitAndLoss);
reportsRouter.get("/balance-sheet", reportsController.balanceSheet);
reportsRouter.get("/cash-flow", reportsController.cashFlow);
reportsRouter.get("/aged-receivables", reportsController.agedReceivables);
reportsRouter.get("/vehicle-profitability", reportsController.vehicleProfitability);
reportsRouter.get("/geofence-violations", reportsController.geofenceViolations);
