import { Router } from "express";
import { zarveSyncController } from "../controllers/zarveSync.controller";
import { requireAuth } from "../middlewares/auth";

export const zarveSyncRouter = Router();

zarveSyncRouter.use(requireAuth);
zarveSyncRouter.get("/history", zarveSyncController.history);
zarveSyncRouter.get("/preview", zarveSyncController.preview);
zarveSyncRouter.post("/", zarveSyncController.run);
