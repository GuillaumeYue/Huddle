import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pool } from "./db.js";

/**
 * Minimal forward-only migration runner.
 *
 * Rules of the game:
 * - migrations/*.sql apply in filename order (001_, 002_, ...).
 * - Applied filenames are recorded in schema_migrations; a file runs
 *   exactly once per database.
 * - Migrations are append-only history. NEVER edit an applied file —
 *   the database already acted on the old text and will not notice the
 *   change. Fixing a mistake means writing the next migration.
 * - Each file runs inside a transaction: it fully applies or fully
 *   doesn't. No half-created schema to hand-repair.
 */
async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const dir = path.join(import.meta.dirname, "..", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed`, { cause: err });
    } finally {
      client.release();
    }
  }
  console.log("migrations up to date");
}

await migrate();
await pool.end();
