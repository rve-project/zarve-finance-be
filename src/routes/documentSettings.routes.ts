import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Router } from "express";
import multer from "multer";
import { documentSettingsController } from "../controllers/documentSettings.controller";
import { requireAuth } from "../middlewares/auth";

const UPLOAD_DIR = path.join(__dirname, "../../uploads/document-settings");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype));
  },
});

export const documentSettingsRouter = Router();

documentSettingsRouter.use(requireAuth);
documentSettingsRouter.get("/", documentSettingsController.get);
documentSettingsRouter.put("/", documentSettingsController.update);
documentSettingsRouter.post("/upload-logo", upload.single("logo"), documentSettingsController.uploadLogo);
