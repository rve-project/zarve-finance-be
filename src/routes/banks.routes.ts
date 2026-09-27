import { Router } from "express";
import { banksController } from "../controllers/banks.controller";
import { requireAuth } from "../middlewares/auth";

export const banksRouter = Router();

banksRouter.use(requireAuth);
banksRouter.get("/", banksController.list);
banksRouter.post("/", banksController.create);
banksRouter.put("/:id", banksController.update);
