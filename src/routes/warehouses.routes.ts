import { Router } from "express";
import { warehousesController } from "../controllers/warehouses.controller";
import { requireAuth } from "../middlewares/auth";

export const warehousesRouter = Router();

warehousesRouter.use(requireAuth);
warehousesRouter.get("/", warehousesController.list);
warehousesRouter.post("/", warehousesController.create);
