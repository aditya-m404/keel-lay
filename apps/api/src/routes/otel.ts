import { Hono } from "hono";

const SECRET = /cookie|authorization/i;
const INVALID = { error: { code: "invalid_body", message: "The request is invalid." } };

function scrub(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) scrub(item);
    return;
  }
  const record = value as Record<string, unknown> & { attributes?: { key?: string }[] };
  if (Array.isArray(record.attributes)) {
    record.attributes = record.attributes.filter((item) => !SECRET.test(item.key ?? ""));
  }
  for (const child of Object.values(record)) scrub(child);
}

export function otelRoutes(): Hono {
  const app = new Hono();
  app.post("/otel", async (c) => {
    const raw = await c.req.text();
    if (!raw) return c.json(INVALID, 400);
    const type = c.req.header("content-type") ?? "application/json";
    let body = raw;
    if (type.includes("json")) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        scrub(parsed);
        body = JSON.stringify(parsed);
      } catch {
        return c.json(INVALID, 400);
      }
    }
    const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4418").replace(/\/$/, "");
    const forwarded = await fetch(`${endpoint}/v1/traces`, {
      method: "POST",
      headers: { "content-type": type.includes("json") ? "application/json" : type },
      body,
    });
    if (!forwarded.ok) return c.json({ error: { code: "internal", message: "The request failed." } }, 502);
    return c.body(null, 204);
  });
  return app;
}
