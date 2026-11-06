import { createHash } from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type pg from "pg";
import type { User } from "@keel/contracts/session";

const COOKIE = "keel_session";

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function currentUser(pool: pg.Pool, c: Context): Promise<User | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const found = await pool.query<User>(
    `SELECT u.id, u.email, u.name, u.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash(token)],
  );
  return found.rows[0] ?? null;
}
