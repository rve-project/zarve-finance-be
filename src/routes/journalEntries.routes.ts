import { Router } from "express";
import { journalEntriesController } from "../controllers/journalEntries.controller";
import { requireAuth } from "../middlewares/auth";

export const journalEntriesRouter = Router();

journalEntriesRouter.use(requireAuth);
journalEntriesRouter.get("/", journalEntriesController.list);
journalEntriesRouter.get("/:id", journalEntriesController.get);
journalEntriesRouter.post("/", journalEntriesController.create);
journalEntriesRouter.post("/:id/reverse", journalEntriesController.reverse);
