import { Router } from "express";
import { usersController } from "../controllers/users.controller";
import { requireAuth } from "../middlewares/auth";

export const usersRouter = Router();

usersRouter.use(requireAuth);
usersRouter.get("/", usersController.list);
usersRouter.post("/", usersController.create);
usersRouter.put("/:id", usersController.update);
usersRouter.delete("/:id", usersController.remove);
