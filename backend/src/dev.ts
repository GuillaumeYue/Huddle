import { Router } from "express";
import { pool } from "./db.js";

/**
 * Dev-only scaffolding — DELETE THIS FILE when Sign in with Apple lands.
 * It exists so the rooms flow can be exercised end-to-end before auth:
 * real identity will come from the SIWA identity token, not a POST body.
 */
export const devRouter = Router();

devRouter.post("/dev/users", async (req, res) => {
  const displayName: unknown = req.body?.displayName;
  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    res.status(400).json({ error: "displayName (string) is required" });
    return;
  }
  const { rows } = await pool.query<{ id: string; display_name: string }>(
    "INSERT INTO users (display_name) VALUES ($1) RETURNING id, display_name",
    [displayName.trim()],
  );
  const user = rows[0]!;
  res.status(201).json({ id: user.id, displayName: user.display_name });
});
