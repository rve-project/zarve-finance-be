import { pool } from "./db";
import { hashPassword } from "./utils/password";

async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL || "admin@rve.local";
  const password = process.env.SEED_ADMIN_PASSWORD || "admin123";
  const name = process.env.SEED_ADMIN_NAME || "Administrator";

  const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
  if ((existing as any[])[0]) {
    console.log(`Admin user ${email} already exists, skipping.`);
    return;
  }

  await pool.query("INSERT INTO users (email, name, password_hash, role, aktif) VALUES (?, ?, ?, 'admin', TRUE)", [
    email,
    name,
    hashPassword(password),
  ]);
  console.log(`Seeded admin user: ${email} / ${password} (change this password after first login)`);
}

seedAdmin()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
