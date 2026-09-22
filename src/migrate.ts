import fs from "fs";
import path from "path";
import { pool } from "./db";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(191) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const [rows] = await pool.query("SELECT name FROM schema_migrations");
  return new Set((rows as { name: string }[]).map((r) => r.name));
}

async function run() {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const statements = sql
      .split(/;\s*(?:\r?\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const statement of statements) {
        await conn.query(statement);
      }
      await conn.query("INSERT INTO schema_migrations (name) VALUES (?)", [file]);
      await conn.commit();
      console.log(`apply ${file}`);
    } catch (err) {
      await conn.rollback();
      console.error(`FAILED ${file}`);
      throw err;
    } finally {
      conn.release();
    }
  }

  console.log("Migrations complete.");
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
