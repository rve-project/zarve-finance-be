import { Router } from "express";
import { contactsController } from "../controllers/contacts.controller";
import { requireAuth } from "../middlewares/auth";

export const contactsRouter = Router();

contactsRouter.use(requireAuth);
contactsRouter.get("/", contactsController.list);
contactsRouter.post("/", contactsController.create);
