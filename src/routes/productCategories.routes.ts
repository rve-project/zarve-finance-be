import { Router } from "express";
import { productCategoriesController } from "../controllers/productCategories.controller";
import { requireAuth } from "../middlewares/auth";

export const productCategoriesRouter = Router();

productCategoriesRouter.use(requireAuth);
productCategoriesRouter.get("/", productCategoriesController.list);
productCategoriesRouter.post("/", productCategoriesController.create);
