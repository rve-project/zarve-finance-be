import { Router } from "express";
import { expensesController } from "../controllers/expenses.controller";
import { requireAuth } from "../middlewares/auth";

export const expensesRouter = Router();

expensesRouter.use(requireAuth);
expensesRouter.get("/stats", expensesController.stats);
expensesRouter.get("/", expensesController.list);
expensesRouter.get("/:id", expensesController.get);
expensesRouter.post("/", expensesController.create);
expensesRouter.put("/:id", expensesController.update);
expensesRouter.delete("/:id", expensesController.remove);
