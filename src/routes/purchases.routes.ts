import { Router } from "express";
import { purchasesController } from "../controllers/purchases.controller";
import { requireAuth } from "../middlewares/auth";

export const purchasesRouter = Router();

purchasesRouter.use(requireAuth);
purchasesRouter.get("/stats", purchasesController.stats);
purchasesRouter.get("/", purchasesController.list);
purchasesRouter.get("/:id", purchasesController.get);
purchasesRouter.post("/", purchasesController.create);
purchasesRouter.put("/:id", purchasesController.update);
purchasesRouter.delete("/:id", purchasesController.remove);
purchasesRouter.post("/:id/submit", purchasesController.submit);
purchasesRouter.post("/:id/approve", purchasesController.approve);
purchasesRouter.post("/:id/reject", purchasesController.reject);
purchasesRouter.post("/:id/convert", purchasesController.convert);
purchasesRouter.post("/:id/payments", purchasesController.addPayment);
