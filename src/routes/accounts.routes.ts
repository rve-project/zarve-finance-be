import { Router } from "express";
import { accountsController } from "../controllers/accounts.controller";
import { requireAuth } from "../middlewares/auth";

export const accountsRouter = Router();

accountsRouter.use(requireAuth);
accountsRouter.get("/", accountsController.list);
accountsRouter.get("/:id", accountsController.get);
accountsRouter.post("/", accountsController.create);
accountsRouter.put("/:id", accountsController.update);
