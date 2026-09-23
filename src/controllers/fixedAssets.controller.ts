import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { postJournalEntry } from "../utils/ledger";
import { computeDepreciation, periodDepreciation, SUPPORTED_DEPRECIATION_METHODS } from "../utils/depreciation";

/**
 * Fixed asset register (B2B): buying an asset posts a real journal entry (debit the
 * chosen Fixed Asset account, credit whatever paid for it). Depreciation parameters
 * are stored so book value / a monthly schedule can be computed and shown, but posting
 * depreciation itself stays a manual Jurnal Manual entry for now -- not auto-posted.
 */

function mapAssetRow(row: any) {
  return {
    id: row.id,
    assetNumber: row.asset_number,
    name: row.name,
    description: row.description,
    categoryAccountId: row.category_account_id,
    categoryAccountCode: row.category_account_code,
    categoryAccountName: row.category_account_name,
    acquisitionDate: row.acquisition_date,
    acquisitionCost: Number(row.acquisition_cost),
    creditAccountId: row.credit_account_id,
    isNonDepreciating: !!row.is_non_depreciating,
    depreciationMethod: row.depreciation_method,
    usefulLifeYears: row.useful_life_years === null ? null : Number(row.useful_life_years),
    depreciationExpenseAccountId: row.depreciation_expense_account_id,
    accumulatedDepreciationAccountId: row.accumulated_depreciation_account_id,
    openingAccumulatedDepreciation: Number(row.opening_accumulated_depreciation),
    openingAccumulatedDepreciationDate: row.opening_accumulated_depreciation_date,
    status: row.status,
    disposalDate: row.disposal_date,
    disposalAmount: row.disposal_amount === null ? null : Number(row.disposal_amount),
    disposalJournalEntryId: row.disposal_journal_entry_id,
    purchaseJournalEntryId: row.purchase_journal_entry_id,
    createdAt: row.created_at,
  };
}

async function findAccountByCategoryValue(businessUnit: string, categoryValue: string): Promise<number | null> {
  const [rows] = await pool.query(
    `SELECT a.id FROM accounts a
     JOIN account_categories c ON c.id = a.category_id
     WHERE a.business_unit = ? AND c.business_unit = ? AND c.value = ? AND a.is_active = TRUE
     ORDER BY a.id LIMIT 1`,
    [businessUnit, businessUnit, categoryValue]
  );
  const row = (rows as any[])[0];
  return row ? row.id : null;
}

async function nextAssetNumber(businessUnit: string): Promise<string> {
  const [rows] = await pool.query("SELECT COUNT(*) AS cnt FROM fixed_assets WHERE business_unit = ?", [businessUnit]);
  return String(10001 + (rows as any[])[0].cnt);
}

export const fixedAssetsController = {
  /** Real list, not a hardcoded frontend string -- only methods this app can
   * actually compute (see SUPPORTED_DEPRECIATION_METHODS). */
  async depreciationMethods(_req: Request, res: Response) {
    res.json(SUPPORTED_DEPRECIATION_METHODS);
  },

  /** "Aset Tertunda": manual journal entries that already debited a Fixed Assets
   * category account but were never registered as a tracked asset -- e.g. someone
   * recorded the purchase via Jurnal Manual directly instead of this screen. */
  async pending(req: Request, res: Response) {
    const [rows] = await pool.query(
      `SELECT jl.id AS line_id, jl.journal_entry_id, jl.debit, jl.description AS line_description,
         je.date, je.ref, je.narration, a.id AS account_id, a.code AS account_code, a.name AS account_name
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       JOIN accounts a ON a.id = jl.account_id
       JOIN account_categories c ON c.id = a.category_id
       WHERE je.business_unit = ? AND c.business_unit = ? AND c.value = 'fixed_asset' AND jl.debit > 0
         AND jl.journal_entry_id NOT IN (
           SELECT purchase_journal_entry_id FROM fixed_assets WHERE purchase_journal_entry_id IS NOT NULL
         )
       ORDER BY je.date DESC, jl.id DESC`,
      [req.businessUnit, req.businessUnit]
    );

    res.json(
      (rows as any[]).map((r) => ({
        journalLineId: r.line_id,
        journalEntryId: r.journal_entry_id,
        date: r.date,
        ref: r.ref,
        description: r.line_description ?? r.narration,
        accountId: r.account_id,
        accountCode: r.account_code,
        accountName: r.account_name,
        amount: Number(r.debit),
      }))
    );
  },

  async active(req: Request, res: Response) {
    const [rows] = await pool.query(
      `SELECT fa.*, a.code AS category_account_code, a.name AS category_account_name
       FROM fixed_assets fa
       JOIN accounts a ON a.id = fa.category_account_id
       WHERE fa.business_unit = ? AND fa.status = 'active'
       ORDER BY fa.acquisition_date DESC, fa.id DESC`,
      [req.businessUnit]
    );
    const today = new Date().toISOString().slice(0, 10);
    res.json(
      (rows as any[]).map((r) => {
        const asset = mapAssetRow(r);
        const dep = computeDepreciation(
          {
            acquisitionDate: asset.acquisitionDate,
            acquisitionCost: asset.acquisitionCost,
            isNonDepreciating: asset.isNonDepreciating,
            usefulLifeYears: asset.usefulLifeYears,
            openingAccumulatedDepreciation: asset.openingAccumulatedDepreciation,
          },
          today
        );
        return { ...asset, accumulatedDepreciation: dep.accumulatedDepreciation, bookValue: dep.bookValue };
      })
    );
  },

  async disposed(req: Request, res: Response) {
    const [rows] = await pool.query(
      `SELECT fa.*, a.code AS category_account_code, a.name AS category_account_name
       FROM fixed_assets fa
       JOIN accounts a ON a.id = fa.category_account_id
       WHERE fa.business_unit = ? AND fa.status = 'disposed'
       ORDER BY fa.disposal_date DESC, fa.id DESC`,
      [req.businessUnit]
    );
    const todayIso = new Date().toISOString().slice(0, 10);
    res.json(
      (rows as any[]).map((r) => {
        const asset = mapAssetRow(r);
        const dep = computeDepreciation(
          {
            acquisitionDate: asset.acquisitionDate,
            acquisitionCost: asset.acquisitionCost,
            isNonDepreciating: asset.isNonDepreciating,
            usefulLifeYears: asset.usefulLifeYears,
            openingAccumulatedDepreciation: asset.openingAccumulatedDepreciation,
          },
          asset.disposalDate ?? todayIso
        );
        const gainLoss = Math.round(((asset.disposalAmount ?? 0) - dep.bookValue) * 100) / 100;
        return { ...asset, bookValueAtDisposal: dep.bookValue, gainLoss };
      })
    );
  },

  async depreciationSchedule(req: Request, res: Response) {
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    const periodStart = `${month}-01`;

    const [rows] = await pool.query(
      `SELECT fa.*, a.code AS category_account_code, a.name AS category_account_name
       FROM fixed_assets fa
       JOIN accounts a ON a.id = fa.category_account_id
       WHERE fa.business_unit = ? AND fa.status = 'active' AND fa.is_non_depreciating = FALSE
         AND fa.acquisition_date <= LAST_DAY(?)
       ORDER BY fa.name`,
      [req.businessUnit, periodStart]
    );

    const data = (rows as any[])
      .map((r) => {
        const asset = mapAssetRow(r);
        const amount = periodDepreciation(
          {
            acquisitionDate: asset.acquisitionDate,
            acquisitionCost: asset.acquisitionCost,
            isNonDepreciating: asset.isNonDepreciating,
            usefulLifeYears: asset.usefulLifeYears,
            openingAccumulatedDepreciation: asset.openingAccumulatedDepreciation,
          },
          periodStart
        );
        return { asset, amount };
      })
      .filter((r) => r.amount > 0)
      .map((r) => ({
        assetId: r.asset.id,
        assetNumber: r.asset.assetNumber,
        assetName: r.asset.name,
        period: month,
        method: r.asset.depreciationMethod,
        value: r.asset.acquisitionCost,
        amount: r.amount,
      }));

    res.json({ month, data });
  },

  async create(req: Request, res: Response) {
    const {
      name,
      assetNumber,
      categoryAccountId,
      acquisitionDate,
      acquisitionCost,
      creditAccountId,
      description,
      isNonDepreciating,
      depreciationMethod,
      usefulLifeYears,
      depreciationExpenseAccountId,
      accumulatedDepreciationAccountId,
      openingAccumulatedDepreciation,
      openingAccumulatedDepreciationDate,
      sourceJournalLineId,
    } = req.body;

    if (!name || !categoryAccountId || !acquisitionDate || !acquisitionCost) {
      throw new ApiError(400, "Nama, akun aset tetap, tanggal akuisisi, dan biaya akuisisi wajib diisi");
    }
    if (!isNonDepreciating && !sourceJournalLineId && (!usefulLifeYears || Number(usefulLifeYears) <= 0)) {
      throw new ApiError(400, "Masa manfaat wajib diisi untuk aset yang disusutkan");
    }

    const finalAssetNumber = assetNumber || (await nextAssetNumber(req.businessUnit));

    let purchaseJournalEntryId: number | null = null;

    if (sourceJournalLineId) {
      // Activating a pending line -- it's already posted, just link it instead of
      // posting a second journal entry for the same purchase.
      const [lineRows] = await pool.query(
        `SELECT jl.journal_entry_id FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         WHERE jl.id = ? AND je.business_unit = ?`,
        [sourceJournalLineId, req.businessUnit]
      );
      const line = (lineRows as any[])[0];
      if (!line) throw new ApiError(400, "Jurnal sumber tidak ditemukan");
      purchaseJournalEntryId = line.journal_entry_id;
    } else {
      if (!creditAccountId) throw new ApiError(400, "Akun dikreditkan wajib diisi");
      purchaseJournalEntryId = await postJournalEntry({
        date: acquisitionDate,
        ref: `ASET-${finalAssetNumber}`,
        narration: `Pembelian aset tetap: ${name}`,
        sourceType: "manual",
        businessUnit: req.businessUnit,
        lines: [
          { accountId: Number(categoryAccountId), debit: Number(acquisitionCost), credit: 0 },
          { accountId: Number(creditAccountId), debit: 0, credit: Number(acquisitionCost) },
        ],
      });
    }

    const [result] = await pool.query(
      `INSERT INTO fixed_assets (
         business_unit, asset_number, name, description, category_account_id, acquisition_date, acquisition_cost,
         credit_account_id, is_non_depreciating, depreciation_method, useful_life_years,
         depreciation_expense_account_id, accumulated_depreciation_account_id,
         opening_accumulated_depreciation, opening_accumulated_depreciation_date, purchase_journal_entry_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.businessUnit,
        finalAssetNumber,
        name,
        description || null,
        Number(categoryAccountId),
        acquisitionDate,
        Number(acquisitionCost),
        creditAccountId ? Number(creditAccountId) : null,
        !!isNonDepreciating,
        isNonDepreciating ? null : depreciationMethod || "straight_line",
        isNonDepreciating ? null : Number(usefulLifeYears) || null,
        isNonDepreciating ? null : depreciationExpenseAccountId ? Number(depreciationExpenseAccountId) : null,
        isNonDepreciating ? null : accumulatedDepreciationAccountId ? Number(accumulatedDepreciationAccountId) : null,
        Number(openingAccumulatedDepreciation) || 0,
        openingAccumulatedDepreciationDate || null,
        purchaseJournalEntryId,
      ]
    );

    const insertId = (result as any).insertId;
    const [rows] = await pool.query(
      `SELECT fa.*, a.code AS category_account_code, a.name AS category_account_name
       FROM fixed_assets fa JOIN accounts a ON a.id = fa.category_account_id WHERE fa.id = ?`,
      [insertId]
    );
    res.status(201).json(mapAssetRow((rows as any[])[0]));
  },

  async dispose(req: Request, res: Response) {
    const { disposalDate, disposalAmount, receivedAccountId } = req.body;
    if (!disposalDate || disposalAmount === undefined || disposalAmount === null || !receivedAccountId) {
      throw new ApiError(400, "Tanggal, harga jual, dan akun penerimaan wajib diisi");
    }

    const [rows] = await pool.query("SELECT * FROM fixed_assets WHERE id = ?", [req.params.id]);
    const row = (rows as any[])[0];
    if (!row || row.business_unit !== req.businessUnit) throw new ApiError(404, "Aset tidak ditemukan");
    if (row.status === "disposed") throw new ApiError(400, "Aset ini sudah dilepas sebelumnya");

    const asset = mapAssetRow(row);
    const dep = computeDepreciation(
      {
        acquisitionDate: asset.acquisitionDate,
        acquisitionCost: asset.acquisitionCost,
        isNonDepreciating: asset.isNonDepreciating,
        usefulLifeYears: asset.usefulLifeYears,
        openingAccumulatedDepreciation: asset.openingAccumulatedDepreciation,
      },
      disposalDate
    );
    const saleAmount = Number(disposalAmount);
    const gainLoss = Math.round((saleAmount - dep.bookValue) * 100) / 100;

    if (dep.accumulatedDepreciation > 0 && !asset.accumulatedDepreciationAccountId) {
      throw new ApiError(400, "Aset ini punya akumulasi penyusutan tapi tidak punya akun akumulasi penyusutan -- lengkapi datanya dulu.");
    }

    const lines = [
      { accountId: Number(receivedAccountId), debit: saleAmount, credit: 0 },
      ...(dep.accumulatedDepreciation > 0 ? [{ accountId: asset.accumulatedDepreciationAccountId as number, debit: dep.accumulatedDepreciation, credit: 0 }] : []),
      { accountId: asset.categoryAccountId, debit: 0, credit: asset.acquisitionCost },
    ];

    if (gainLoss > 0) {
      const gainAccountId = await findAccountByCategoryValue(req.businessUnit, "other_income");
      if (!gainAccountId) throw new ApiError(400, "Tidak ada akun kategori 'Other Income' untuk mencatat keuntungan pelepasan aset.");
      lines.push({ accountId: gainAccountId, debit: 0, credit: gainLoss });
    } else if (gainLoss < 0) {
      const lossAccountId = await findAccountByCategoryValue(req.businessUnit, "other_expense");
      if (!lossAccountId) throw new ApiError(400, "Tidak ada akun kategori 'Other Expense' untuk mencatat kerugian pelepasan aset.");
      lines.push({ accountId: lossAccountId, debit: -gainLoss, credit: 0 });
    }

    const disposalJournalEntryId = await postJournalEntry({
      date: disposalDate,
      ref: `LEPAS-${asset.assetNumber}`,
      narration: `Pelepasan aset tetap: ${asset.name}`,
      sourceType: "manual",
      businessUnit: req.businessUnit,
      lines,
    });

    await pool.query(
      "UPDATE fixed_assets SET status = 'disposed', disposal_date = ?, disposal_amount = ?, disposal_journal_entry_id = ? WHERE id = ?",
      [disposalDate, saleAmount, disposalJournalEntryId, asset.id]
    );

    res.status(201).json({ disposalJournalEntryId, bookValueAtDisposal: dep.bookValue, gainLoss });
  },
};
