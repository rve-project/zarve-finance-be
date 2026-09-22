import { Router } from "express";
import { reconciliationController } from "../controllers/reconciliation.controller";
import { requireAuth } from "../middlewares/auth";

export const reconciliationRouter = Router();

reconciliationRouter.use(requireAuth);
reconciliationRouter.get("/unreconciled", reconciliationController.unreconciled);
reconciliationRouter.get("/bank-accounts", reconciliationController.bankAccounts);
reconciliationRouter.get("/history", reconciliationController.history);
reconciliationRouter.post("/", reconciliationController.create);
