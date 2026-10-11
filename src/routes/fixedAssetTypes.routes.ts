import { Router } from "express";
import { fixedAssetTypesController } from "../controllers/fixedAssetTypes.controller";
import { requireAuth } from "../middlewares/auth";

export const fixedAssetTypesRouter = Router();

fixedAssetTypesRouter.use(requireAuth);
fixedAssetTypesRouter.get("/", fixedAssetTypesController.list);
fixedAssetTypesRouter.post("/", fixedAssetTypesController.create);
fixedAssetTypesRouter.put("/:id", fixedAssetTypesController.update);
