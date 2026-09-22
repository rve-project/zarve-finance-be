import { Router } from "express";
import { vendorPaymentsController } from "../controllers/vendorPayments.controller";
import { requireAuth } from "../middlewares/auth";

export const vendorPaymentsRouter = Router();

vendorPaymentsRouter.use(requireAuth);
vendorPaymentsRouter.get("/", vendorPaymentsController.list);
vendorPaymentsRouter.post("/", vendorPaymentsController.create);
