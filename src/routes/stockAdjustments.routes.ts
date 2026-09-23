import { Router } from "express";
import { stockAdjustmentsController } from "../controllers/stockAdjustments.controller";
import { requireAuth } from "../middlewares/auth";

export const stockAdjustmentsRouter = Router();

stockAdjustmentsRouter.use(requireAuth);
stockAdjustmentsRouter.get("/", stockAdjustmentsController.list);
stockAdjustmentsRouter.post("/", stockAdjustmentsController.create);
