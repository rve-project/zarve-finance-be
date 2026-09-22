import { Router } from "express";
import { driverRevenueRecapController } from "../controllers/driverRevenueRecap.controller";
import { requireAuth } from "../middlewares/auth";

export const driverRevenueRecapRouter = Router();

driverRevenueRecapRouter.use(requireAuth);
driverRevenueRecapRouter.get("/categories", driverRevenueRecapController.categories);
driverRevenueRecapRouter.get("/", driverRevenueRecapController.get);
driverRevenueRecapRouter.get("/export", driverRevenueRecapController.export);
