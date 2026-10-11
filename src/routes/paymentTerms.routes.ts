import { Router } from "express";
import { paymentTermsController } from "../controllers/paymentTerms.controller";
import { requireAuth } from "../middlewares/auth";

export const paymentTermsRouter = Router();

paymentTermsRouter.use(requireAuth);
paymentTermsRouter.get("/", paymentTermsController.list);
paymentTermsRouter.post("/", paymentTermsController.create);
paymentTermsRouter.put("/:id", paymentTermsController.update);
