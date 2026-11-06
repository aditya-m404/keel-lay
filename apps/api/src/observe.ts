import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { BusinessMetric, Telemetry } from "@keel/otel";

declare module "hono" {
  interface ContextVariableMap {
    keelBusiness?: BusinessMetric;
  }
}

function present(c: Context, name: string): string | undefined {
  const value = c.req.header(name)?.trim();
  return value ? value : undefined;
}

export function observe(telemetry: Telemetry): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      status = 500;
      return c.json({ error: { code: "internal", message: "The request failed." } }, 500);
    } finally {
      const matched = routePath(c, -1);
      const route = matched && matched !== "*" ? matched : "unknown";
      await telemetry.record({
        method: c.req.method,
        route,
        status,
        durationMs: performance.now() - started,
        runId: present(c, "x-keel-run-id"),
        actor: present(c, "x-keel-actor"),
        journey: present(c, "x-keel-journey"),
        step: present(c, "x-keel-step"),
        pace: present(c, "x-keel-pace"),
        business: c.get("keelBusiness"),
      });
    }
  };
}
