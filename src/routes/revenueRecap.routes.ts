import { Router } from "express";
import { revenueRecapController } from "../controllers/revenueRecap.controller";
import { requireAuth } from "../middlewares/auth";

export const revenueRecapRouter = Router();

revenueRecapRouter.use(requireAuth);
revenueRecapRouter.get("/", revenueRecapController.get);
revenueRecapRouter.get("/export", revenueRecapController.export);
