import { Request, Response } from "express";
import { getSettings, updateSettings } from "../utils/settings";

export const settingsController = {
  async get(_req: Request, res: Response) {
    res.json(await getSettings());
  },

  async update(req: Request, res: Response) {
    const { defaultIncomeAccountEvId, defaultIncomeAccountFuelId, autoCreatePayment, ppnEnabled, ppnRate, periodLockDays } = req.body;
    const settings = await updateSettings({
      defaultIncomeAccountEvId,
      defaultIncomeAccountFuelId,
      autoCreatePayment,
      ppnEnabled,
      ppnRate,
      periodLockDays,
    });
    res.json(settings);
  },
};
