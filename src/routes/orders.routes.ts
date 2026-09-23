import { Router } from "express";
import { ordersController } from "../controllers/orders.controller";
import { requireAuth } from "../middlewares/auth";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);
ordersRouter.get("/", ordersController.list);
ordersRouter.post("/", ordersController.create);
ordersRouter.put("/:id/status", ordersController.updateStatus);
