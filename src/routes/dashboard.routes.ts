import { Router } from "express";
import { dashboardController } from "../controllers/dashboard.controller";
import { requireAuth } from "../middlewares/auth";

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);
dashboardRouter.get("/invoice-status-summary", dashboardController.invoiceStatusSummary);
