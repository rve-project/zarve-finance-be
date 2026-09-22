import { Request, Response } from "express";
import { ApiError } from "../middlewares/errorHandler";
import { getLastSyncInfo, isSyncRunning } from "../utils/zarveMirrorSync";
import { syncAndPost } from "../scheduler";

/**
 * Kicks off in the background and returns immediately -- pulling the full Zarve
 * invoice history + posting to the ledger takes 10-15+ minutes, far too long to hold
 * a single HTTP request open. The frontend polls `status` instead (see /import page)
 * to show progress. Runs the exact same sync-then-post routine as the nightly cron
 * (see scheduler.ts) -- a manual run behaves identically to a scheduled one.
 */
export const zarveMirrorController = {
  async sync(_req: Request, res: Response) {
    if (await isSyncRunning()) {
      throw new ApiError(409, "Sinkronisasi sedang berjalan, tunggu sampai selesai.");
    }
    syncAndPost().catch((err) => {
      console.error("Zarve sync+post failed:", err);
    });
    res.status(202).json({ started: true });
  },

  async status(_req: Request, res: Response) {
    const info = await getLastSyncInfo();
    res.json(info);
  },
};
