import { Router } from "express";
import { vendorBillsController } from "../controllers/vendorBills.controller";
import { requireAuth } from "../middlewares/auth";

export const vendorBillsRouter = Router();

vendorBillsRouter.use(requireAuth);
vendorBillsRouter.get("/", vendorBillsController.list);
vendorBillsRouter.get("/:id", vendorBillsController.get);
vendorBillsRouter.post("/", vendorBillsController.create);
