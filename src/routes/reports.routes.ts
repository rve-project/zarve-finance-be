import { Router } from "express";
import { reportsController } from "../controllers/reports.controller";
import { requireAuth } from "../middlewares/auth";

export const reportsRouter = Router();

reportsRouter.use(requireAuth);
reportsRouter.get("/trial-balance", reportsController.trialBalance);
reportsRouter.get("/trial-balance/export", reportsController.exportTrialBalance);
reportsRouter.get("/general-ledger", reportsController.generalLedger);
reportsRouter.get("/general-ledger/export", reportsController.exportGeneralLedger);
reportsRouter.get("/profit-loss", reportsController.profitAndLoss);
reportsRouter.get("/profit-loss/export", reportsController.exportProfitAndLoss);
reportsRouter.get("/balance-sheet", reportsController.balanceSheet);
reportsRouter.get("/balance-sheet/export", reportsController.exportBalanceSheet);
reportsRouter.get("/equity-changes", reportsController.equityChanges);
reportsRouter.get("/equity-changes/export", reportsController.exportEquityChanges);
reportsRouter.get("/cash-flow", reportsController.cashFlow);
reportsRouter.get("/cash-flow/export", reportsController.exportCashFlow);
reportsRouter.get("/aged-receivables", reportsController.agedReceivables);
reportsRouter.get("/vehicle-profitability", reportsController.vehicleProfitability);
reportsRouter.get("/geofence-violations", reportsController.geofenceViolations);
reportsRouter.get("/journal-validation", reportsController.journalValidation);
