import { Router } from "express";
import { invoicesController } from "../controllers/invoices.controller";
import { requireAuth } from "../middlewares/auth";

export const invoicesRouter = Router();

invoicesRouter.use(requireAuth);
invoicesRouter.get("/", invoicesController.list);
invoicesRouter.get("/:id", invoicesController.get);
invoicesRouter.post("/", invoicesController.create);
