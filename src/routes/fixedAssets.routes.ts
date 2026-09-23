import { Router } from "express";
import { fixedAssetsController } from "../controllers/fixedAssets.controller";
import { requireAuth } from "../middlewares/auth";

export const fixedAssetsRouter = Router();

fixedAssetsRouter.use(requireAuth);
fixedAssetsRouter.get("/depreciation-methods", fixedAssetsController.depreciationMethods);
fixedAssetsRouter.get("/pending", fixedAssetsController.pending);
fixedAssetsRouter.get("/active", fixedAssetsController.active);
fixedAssetsRouter.get("/disposed", fixedAssetsController.disposed);
fixedAssetsRouter.get("/depreciation-schedule", fixedAssetsController.depreciationSchedule);
fixedAssetsRouter.post("/", fixedAssetsController.create);
fixedAssetsRouter.post("/:id/dispose", fixedAssetsController.dispose);
