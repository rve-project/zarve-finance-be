import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { Account, AccountAccessMode, AccountType } from "../models/types";

const ACCOUNT_TYPES: AccountType[] = ["asset", "liability", "equity", "income", "expense"];
const ACCESS_MODES: AccountAccessMode[] = ["all", "some"];

function mapRow(row: any): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    parentId: row.parent_id,
    isActive: !!row.is_active,
    businessUnit: row.business_unit,
    description: row.description,
    categoryId: row.category_id,
    taxId: row.tax_id,
    accessMode: row.access_mode,
  };
}

async function getAccessUserIds(accountId: number): Promise<number[]> {
  const [rows] = await pool.query("SELECT user_id FROM account_access_users WHERE account_id = ?", [accountId]);
  return (rows as any[]).map((r) => r.user_id);
}

/** Replaces the account's access-user list wholesale -- simpler and safer than a
 * diff, and this list is small (picked from a dropdown, not a bulk import). */
async function setAccessUserIds(accountId: number, userIds: number[]): Promise<void> {
  await pool.query("DELETE FROM account_access_users WHERE account_id = ?", [accountId]);
  if (userIds.length) {
    await pool.query("INSERT INTO account_access_users (account_id, user_id) VALUES ?", [userIds.map((id) => [accountId, id])]);
  }
}

export const accountsController = {
  async list(req: Request, res: Response) {
    const { type } = req.query;
    const clauses: string[] = ["business_unit = ?"];
    const params: unknown[] = [req.businessUnit];
    if (type) {
      clauses.push("type = ?");
      params.push(type);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const [rows] = await pool.query(`SELECT * FROM accounts ${where} ORDER BY code`, params);
    res.json((rows as any[]).map(mapRow));
  },

  async get(req: Request, res: Response) {
    const [rows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.params.id]);
    const list = rows as any[];
    if (!list[0] || list[0].business_unit !== req.businessUnit) throw new ApiError(404, "Akun tidak ditemukan");
    const accessUserIds = list[0].access_mode === "some" ? await getAccessUserIds(list[0].id) : [];
    res.json({ ...mapRow(list[0]), accessUserIds });
  },

  async create(req: Request, res: Response) {
    const { code, name, type, parentId, description, categoryId, taxId, accessMode, accessUserIds } = req.body;

    let resolvedType = type;
    if (categoryId) {
      const [catRows] = await pool.query("SELECT type FROM account_categories WHERE id = ? AND business_unit = ?", [
        categoryId,
        req.businessUnit,
      ]);
      const category = (catRows as any[])[0];
      if (!category) throw new ApiError(400, "Kategori akun tidak ditemukan");
      resolvedType = category.type;
    }
    if (!code || !name || !resolvedType) throw new ApiError(400, "Kode, nama, dan tipe/kategori akun wajib diisi");
    if (!ACCOUNT_TYPES.includes(resolvedType)) throw new ApiError(400, `Tipe akun harus salah satu dari: ${ACCOUNT_TYPES.join(", ")}`);
    const resolvedAccessMode: AccountAccessMode = ACCESS_MODES.includes(accessMode) ? accessMode : "all";

    const [result] = await pool.query(
      "INSERT INTO accounts (code, name, type, parent_id, business_unit, description, category_id, tax_id, access_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [code, name, resolvedType, parentId ?? null, req.businessUnit, description ?? null, categoryId ?? null, taxId ?? null, resolvedAccessMode]
    );
    const insertId = (result as any).insertId;

    const userIds: number[] = resolvedAccessMode === "some" && Array.isArray(accessUserIds) ? accessUserIds.map(Number) : [];
    if (userIds.length) await setAccessUserIds(insertId, userIds);

    const [rows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [insertId]);
    res.status(201).json({ ...mapRow((rows as any[])[0]), accessUserIds: userIds });
  },

  async update(req: Request, res: Response) {
    const { name, isActive, parentId, description, categoryId, taxId, accessMode, accessUserIds } = req.body;
    const [existing] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current || current.business_unit !== req.businessUnit) throw new ApiError(404, "Akun tidak ditemukan");

    const resolvedAccessMode: AccountAccessMode = ACCESS_MODES.includes(accessMode) ? accessMode : current.access_mode;

    await pool.query(
      "UPDATE accounts SET name = ?, is_active = ?, parent_id = ?, description = ?, category_id = ?, tax_id = ?, access_mode = ? WHERE id = ?",
      [
        name ?? current.name,
        isActive === undefined ? current.is_active : isActive,
        parentId === undefined ? current.parent_id : parentId,
        description === undefined ? current.description : description,
        categoryId === undefined ? current.category_id : categoryId,
        taxId === undefined ? current.tax_id : taxId,
        resolvedAccessMode,
        req.params.id,
      ]
    );

    if (accessUserIds !== undefined) {
      await setAccessUserIds(Number(req.params.id), resolvedAccessMode === "some" ? accessUserIds.map(Number) : []);
    }

    const [rows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.params.id]);
    const finalAccessUserIds = resolvedAccessMode === "some" ? await getAccessUserIds(Number(req.params.id)) : [];
    res.json({ ...mapRow((rows as any[])[0]), accessUserIds: finalAccessUserIds });
  },
};
