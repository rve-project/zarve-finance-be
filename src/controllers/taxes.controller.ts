import { Request, Response } from "express";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { TaxCode } from "../models/types";

interface TaxComponentInput {
  taxId: number;
  sign: "add" | "subtract";
}

function mapRow(row: any, components: { taxId: number; name: string; rate: number; sign: "add" | "subtract" }[] = []): TaxCode {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    name: row.name,
    rate: Number(row.rate),
    accountId: row.account_id,
    accountName: row.account_name ?? null,
    isCompound: !!row.is_compound,
    components,
    isActive: !!row.is_active,
  };
}

const SELECT_WITH_ACCOUNT = `SELECT t.*, a.name AS account_name FROM taxes t LEFT JOIN accounts a ON a.id = t.account_id`;

async function getComponentsByGroupIds(groupIds: number[]) {
  const map = new Map<number, { taxId: number; name: string; rate: number; sign: "add" | "subtract" }[]>();
  if (!groupIds.length) return map;
  const [rows] = await pool.query(
    `SELECT tc.group_tax_id, tc.sign, t.id AS tax_id, t.name, t.rate
     FROM tax_components tc
     JOIN taxes t ON t.id = tc.component_tax_id
     WHERE tc.group_tax_id IN (?)`,
    [groupIds]
  );
  for (const row of rows as any[]) {
    const list = map.get(row.group_tax_id) ?? [];
    list.push({ taxId: row.tax_id, name: row.name, rate: Number(row.rate), sign: row.sign });
    map.set(row.group_tax_id, list);
  }
  return map;
}

function parseComponents(input: unknown): TaxComponentInput[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((c) => ({ taxId: Number(c?.taxId), sign: c?.sign === "subtract" ? "subtract" : "add" }))
    .filter((c): c is TaxComponentInput => Number.isFinite(c.taxId) && c.taxId > 0);
}

/** Validates the component list and computes the compound tax's own net rate (the
 * signed sum of its components' rates, e.g. PPN 11 - PPH 23 2 = 9) -- so every OTHER
 * tax computation in the app (ExpenseForm/SaleForm/PurchaseForm's amount x rate math)
 * keeps working unchanged for a compound tax; only journal posting (resolveTaxJournalLines
 * in utils/ledger.ts) needs to know about the individual components. */
async function resolveCompoundRate(components: TaxComponentInput[], businessUnit: string): Promise<number> {
  if (components.length < 2) throw new ApiError(400, "Pajak gabungan butuh minimal 2 komponen pajak");
  const [rows] = await pool.query("SELECT id, rate, is_compound FROM taxes WHERE id IN (?) AND business_unit = ?", [
    components.map((c) => c.taxId),
    businessUnit,
  ]);
  const byId = new Map((rows as any[]).map((r) => [r.id, r]));
  let rate = 0;
  for (const c of components) {
    const tax = byId.get(c.taxId);
    if (!tax) throw new ApiError(400, "Salah satu komponen pajak tidak ditemukan");
    if (tax.is_compound) throw new ApiError(400, "Pajak gabungan tidak boleh berisi pajak gabungan lain");
    rate += (c.sign === "subtract" ? -1 : 1) * Number(tax.rate);
  }
  return rate;
}

async function replaceComponents(conn: PoolConnection, groupTaxId: number, components: TaxComponentInput[]) {
  await conn.query("DELETE FROM tax_components WHERE group_tax_id = ?", [groupTaxId]);
  for (const c of components) {
    await conn.query("INSERT INTO tax_components (group_tax_id, component_tax_id, sign) VALUES (?, ?, ?)", [groupTaxId, c.taxId, c.sign]);
  }
}

/**
 * Tax codes (e.g. "PPN 11%") for the B2B "Daftar Akun" create form's Pajak dropdown --
 * previously a dead, disabled placeholder since no tax concept existed at all. Each
 * code can optionally map to its own "akun penampung" (account_id, see migration
 * 052_tax_account.sql) -- the GL account its amount posts to on a sale/purchase/expense,
 * instead of every tax lumping into one hardcoded PPN account regardless of tax type.
 *
 * A tax can also be a "pajak gabungan" (compound tax, see migration
 * 053_compound_taxes.sql) -- a preset bundle of 2+ existing tax codes, selectable as one
 * option in a line's Pajak dropdown (e.g. "PPN 11% + PPH 23 2%"). Its own account_id
 * stays NULL always; posting routes through each COMPONENT's own account instead.
 */
export const taxesController = {
  async list(req: Request, res: Response) {
    const includeArchived = req.query.includeArchived === "true";
    const activeClause = includeArchived ? "" : "AND t.is_active = TRUE";
    const [rows] = await pool.query(`${SELECT_WITH_ACCOUNT} WHERE t.business_unit = ? ${activeClause} ORDER BY t.name`, [req.businessUnit]);
    const taxRows = rows as any[];
    const componentsByGroup = await getComponentsByGroupIds(taxRows.filter((r) => r.is_compound).map((r) => r.id));
    res.json(taxRows.map((row) => mapRow(row, componentsByGroup.get(row.id) ?? [])));
  },

  async create(req: Request, res: Response) {
    const { name, accountId, isCompound } = req.body;
    if (!name) throw new ApiError(400, "Nama pajak wajib diisi");

    const conn: PoolConnection = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let insertId: number;

      if (isCompound) {
        const components = parseComponents(req.body.components);
        const rate = await resolveCompoundRate(components, req.businessUnit);
        const [result] = await conn.query("INSERT INTO taxes (business_unit, name, rate, account_id, is_compound) VALUES (?, ?, ?, NULL, TRUE)", [
          req.businessUnit,
          name,
          rate,
        ]);
        insertId = (result as any).insertId;
        await replaceComponents(conn, insertId, components);
      } else {
        const { rate } = req.body;
        if (rate === undefined || rate === null || rate === "") throw new ApiError(400, "Tarif pajak wajib diisi");
        if (Number.isNaN(Number(rate)) || Number(rate) < 0) throw new ApiError(400, "Tarif pajak harus berupa angka >= 0");
        const [result] = await conn.query("INSERT INTO taxes (business_unit, name, rate, account_id, is_compound) VALUES (?, ?, ?, ?, FALSE)", [
          req.businessUnit,
          name,
          rate,
          accountId ? Number(accountId) : null,
        ]);
        insertId = (result as any).insertId;
      }

      await conn.commit();
      const [rows] = await pool.query(`${SELECT_WITH_ACCOUNT} WHERE t.id = ?`, [insertId]);
      const componentsByGroup = await getComponentsByGroupIds(isCompound ? [insertId] : []);
      res.status(201).json(mapRow((rows as any[])[0], componentsByGroup.get(insertId) ?? []));
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async update(req: Request, res: Response) {
    const [existing] = await pool.query("SELECT * FROM taxes WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current || current.business_unit !== req.businessUnit) throw new ApiError(404, "Pajak tidak ditemukan");

    const { name, accountId, isActive } = req.body;
    const isCompound = req.body.isCompound === undefined ? !!current.is_compound : !!req.body.isCompound;

    const conn: PoolConnection = await pool.getConnection();
    try {
      await conn.beginTransaction();

      if (isCompound) {
        const components = req.body.components === undefined ? null : parseComponents(req.body.components);
        if (components) {
          const rate = await resolveCompoundRate(components, req.businessUnit);
          await conn.query("UPDATE taxes SET name = ?, rate = ?, account_id = NULL, is_compound = TRUE, is_active = ? WHERE id = ?", [
            name ?? current.name,
            rate,
            isActive === undefined ? current.is_active : isActive,
            req.params.id,
          ]);
          await replaceComponents(conn, Number(req.params.id), components);
        } else {
          // Switching an existing simple tax to compound with no components given, or
          // just touching name/isActive on an already-compound tax -- rate/components
          // stay as they are.
          await conn.query("UPDATE taxes SET name = ?, account_id = NULL, is_compound = TRUE, is_active = ? WHERE id = ?", [
            name ?? current.name,
            isActive === undefined ? current.is_active : isActive,
            req.params.id,
          ]);
        }
      } else {
        const { rate } = req.body;
        await conn.query("UPDATE taxes SET name = ?, rate = ?, account_id = ?, is_compound = FALSE, is_active = ? WHERE id = ?", [
          name ?? current.name,
          rate === undefined ? current.rate : rate,
          accountId === undefined ? current.account_id : accountId ? Number(accountId) : null,
          isActive === undefined ? current.is_active : isActive,
          req.params.id,
        ]);
        await conn.query("DELETE FROM tax_components WHERE group_tax_id = ?", [req.params.id]);
      }

      await conn.commit();
      const [rows] = await pool.query(`${SELECT_WITH_ACCOUNT} WHERE t.id = ?`, [req.params.id]);
      const componentsByGroup = await getComponentsByGroupIds(isCompound ? [Number(req.params.id)] : []);
      res.json(mapRow((rows as any[])[0], componentsByGroup.get(Number(req.params.id)) ?? []));
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },
};
