import { Router } from "express";
import { paymentsController } from "../controllers/payments.controller";
import { requireAuth } from "../middlewares/auth";

export const paymentsRouter = Router();

paymentsRouter.use(requireAuth);
paymentsRouter.get("/", paymentsController.list);
paymentsRouter.get("/:id", paymentsController.get);
paymentsRouter.post("/", paymentsController.create);
