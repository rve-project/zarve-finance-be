import { Router } from "express";
import { activityLogsController } from "../controllers/activityLogs.controller";
import { requireAuth } from "../middlewares/auth";

export const activityLogsRouter = Router();

activityLogsRouter.use(requireAuth);
activityLogsRouter.get("/", activityLogsController.list);
