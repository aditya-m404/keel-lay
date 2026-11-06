import { createHash } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";
import type pg from "pg";
import { signInBody, type User } from "@keel/contracts/session";
import { hashPassword, verifyPassword } from "../db/password.ts";
import { newId } from "../ids.ts";

const COOKIE = "keel_session";
const MAX_AGE = 43_200;
const INVALID = { error: { code: "invalid_credentials", message: "Email or password is wrong." } };
const UNAUTHENTICATED = { error: { code: "unauthenticated", message: "Sign in required." } };
const DUMMY_HASH = hashPassword("keel-dummy-password");

type UserRow = User & { password_hash: string };

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    secure: process.env.KEEL_ENV === "production",
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function readUser(pool: pg.Pool, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const found = await pool.query<User & { expires_at: Date }>(
    `SELECT u.id, u.email, u.name, u.role, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash(token)],
  );
  const row = found.rows[0];
  if (!row || row.expires_at.getTime() <= Date.now()) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export function sessionRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  app.post("/session", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "invalid_body", message: "Body must be JSON." } }, 400);
    }
    const parsed = signInBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_body", message: "Sign-in body is invalid." } }, 400);
    }

    const email = parsed.data.email.trim().toLowerCase();
    const found = await pool.query<UserRow>(
      "SELECT id, email, name, role, password_hash FROM users WHERE email = $1",
      [email],
    );
    const row = found.rows[0];
    const matches = verifyPassword(parsed.data.password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !matches) return c.json(INVALID, 401);

    const token = newId("ses_");
    const expires = new Date(Date.now() + MAX_AGE * 1000);
    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
      [newId("ses_"), row.id, tokenHash(token), expires],
    );
    setCookie(c, COOKIE, token, { ...cookieOptions(), maxAge: MAX_AGE });
    return c.json({ user: { id: row.id, email: row.email, name: row.name, role: row.role } }, 201);
  });

  app.get("/session", async (c) => {
    const user = await readUser(pool, getCookie(c, COOKIE));
    if (!user) return c.json(UNAUTHENTICATED, 401);
    return c.json({ user });
  });

  app.delete("/session", async (c) => {
    const token = getCookie(c, COOKIE);
    if (token) {
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
    }
    deleteCookie(c, COOKIE, cookieOptions());
    return c.body(null, 204);
  });

  return app;
}
