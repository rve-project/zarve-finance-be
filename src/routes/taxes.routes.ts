import { Router } from "express";
import { taxesController } from "../controllers/taxes.controller";
import { requireAuth } from "../middlewares/auth";

export const taxesRouter = Router();

taxesRouter.use(requireAuth);
taxesRouter.get("/", taxesController.list);
taxesRouter.post("/", taxesController.create);
taxesRouter.put("/:id", taxesController.update);
