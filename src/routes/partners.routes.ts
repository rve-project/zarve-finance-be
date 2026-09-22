import { Router } from "express";
import { partnersController } from "../controllers/partners.controller";
import { requireAuth } from "../middlewares/auth";

export const partnersRouter = Router();

partnersRouter.use(requireAuth);
partnersRouter.get("/", partnersController.list);
partnersRouter.get("/:id", partnersController.get);
partnersRouter.post("/", partnersController.create);
partnersRouter.put("/:id", partnersController.update);
