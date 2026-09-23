import { Router } from "express";
import multer from "multer";
import { cashBankController } from "../controllers/cashBank.controller";
import { requireAuth } from "../middlewares/auth";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

export const cashBankRouter = Router();

cashBankRouter.use(requireAuth);
cashBankRouter.get("/accounts", cashBankController.accounts);
cashBankRouter.get("/summary", cashBankController.summary);
cashBankRouter.get("/import-template", cashBankController.downloadTemplate);
cashBankRouter.post("/accounts/:accountId/import", upload.single("file"), cashBankController.importStatement);
