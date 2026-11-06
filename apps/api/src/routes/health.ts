import { Hono } from "hono";
import type pg from "pg";

export function healthRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/ready", async (c) => {
    try {
      await pool.query("select 1");
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  return app;
}
