import { Router } from "express";
import { koreksiRequestsController } from "../controllers/koreksiRequests.controller";
import { requireAuth } from "../middlewares/auth";

export const koreksiRequestsRouter = Router();

koreksiRequestsRouter.use(requireAuth);
koreksiRequestsRouter.get("/", koreksiRequestsController.list);
koreksiRequestsRouter.post("/", koreksiRequestsController.create);
koreksiRequestsRouter.post("/:id/approve", koreksiRequestsController.approve);
koreksiRequestsRouter.post("/:id/reject", koreksiRequestsController.reject);
