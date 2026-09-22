import { Router } from "express";
import { vehiclesController } from "../controllers/vehicles.controller";
import { requireAuth } from "../middlewares/auth";

export const vehiclesRouter = Router();

vehiclesRouter.use(requireAuth);
vehiclesRouter.get("/", vehiclesController.list);
vehiclesRouter.get("/:id", vehiclesController.get);
vehiclesRouter.post("/", vehiclesController.create);
vehiclesRouter.put("/:id", vehiclesController.update);
