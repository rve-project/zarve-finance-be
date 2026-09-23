import { Router } from "express";
import { accountCategoriesController } from "../controllers/accountCategories.controller";
import { requireAuth } from "../middlewares/auth";

export const accountCategoriesRouter = Router();

accountCategoriesRouter.use(requireAuth);
accountCategoriesRouter.get("/", accountCategoriesController.list);
accountCategoriesRouter.post("/", accountCategoriesController.create);
accountCategoriesRouter.put("/:id", accountCategoriesController.update);
