import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Router } from "express";
import multer from "multer";
import { productsController } from "../controllers/products.controller";
import { requireAuth } from "../middlewares/auth";

// Real upload -- saved to disk (not memory) so it can be served back later. Lives
// alongside dist/ (not inside it), so a rebuild never wipes previously uploaded
// images. In production this directory needs to be a persistent volume, since a
// container's own filesystem is wiped on redeploy.
const UPLOAD_DIR = path.join(__dirname, "../../uploads/products");
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

export const productsRouter = Router();

productsRouter.use(requireAuth);
productsRouter.get("/", productsController.list);
productsRouter.get("/warehouse-stock", productsController.warehouseStock);
productsRouter.post("/", productsController.create);
productsRouter.post("/upload-image", upload.single("image"), productsController.uploadImage);
productsRouter.put("/:id", productsController.update);
