import { Router } from "express";
import { usersController } from "../controllers/users.controller";
import { requireAuth, requireModule } from "../middlewares/auth";

export const usersRouter = Router();

usersRouter.use(requireAuth, requireModule("administrasi"));
usersRouter.get("/", usersController.list);
usersRouter.post("/", usersController.create);
usersRouter.put("/:id", usersController.update);
usersRouter.delete("/:id", usersController.remove);
