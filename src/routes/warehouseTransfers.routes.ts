import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Router } from "express";
import multer from "multer";
import { warehouseTransfersController } from "../controllers/warehouseTransfers.controller";
import { requireAuth } from "../middlewares/auth";

// Real upload -- saved to disk (not memory) so it can be served back later. Lives
// alongside dist/ (not inside it), so a rebuild never wipes previously uploaded files.
const UPLOAD_DIR = path.join(__dirname, "../../uploads/attachments");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = /^(image\/(jpeg|png)|application\/(pdf|zip|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet))$/;

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_MIME.test(file.mimetype)),
});

export const warehouseTransfersRouter = Router();

warehouseTransfersRouter.use(requireAuth);
warehouseTransfersRouter.get("/", warehouseTransfersController.list);
warehouseTransfersRouter.post("/", warehouseTransfersController.create);
warehouseTransfersRouter.post("/upload-attachment", upload.array("files", 5), warehouseTransfersController.uploadAttachment);
