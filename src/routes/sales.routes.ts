import { Router } from "express";
import { salesController } from "../controllers/sales.controller";
import { requireAuth } from "../middlewares/auth";

export const salesRouter = Router();

salesRouter.use(requireAuth);
salesRouter.get("/stats", salesController.stats);
salesRouter.get("/", salesController.list);
salesRouter.get("/:id", salesController.get);
salesRouter.post("/", salesController.create);
salesRouter.put("/:id", salesController.update);
salesRouter.delete("/:id", salesController.remove);
salesRouter.post("/:id/submit", salesController.submit);
salesRouter.post("/:id/approve", salesController.approve);
salesRouter.post("/:id/reject", salesController.reject);
salesRouter.post("/:id/convert", salesController.convert);
salesRouter.post("/:id/payments", salesController.addPayment);
