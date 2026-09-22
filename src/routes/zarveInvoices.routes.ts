import { Router } from "express";
import { zarveInvoicesController } from "../controllers/zarveInvoices.controller";
import { requireAuth } from "../middlewares/auth";

export const zarveInvoicesRouter = Router();

zarveInvoicesRouter.use(requireAuth);
zarveInvoicesRouter.get("/types", zarveInvoicesController.types);
zarveInvoicesRouter.get("/:id", zarveInvoicesController.detail);
zarveInvoicesRouter.get("/", zarveInvoicesController.list);
