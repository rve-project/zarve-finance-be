import { Router } from "express";
import { zarveMirrorController } from "../controllers/zarveMirror.controller";
import { requireAuth } from "../middlewares/auth";

export const zarveMirrorRouter = Router();

zarveMirrorRouter.use(requireAuth);
zarveMirrorRouter.get("/status", zarveMirrorController.status);
zarveMirrorRouter.post("/sync", zarveMirrorController.sync);
