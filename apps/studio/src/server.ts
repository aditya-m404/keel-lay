import { createServer, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { connect, createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { loadEnv } from "../../api/src/db/env.ts";
import { journeyIds } from "./plan.ts";
import { createRun, getRun, pauseRun, publicRun, stopRun } from "./runs.ts";

const INVALID = { error: { code: "invalid_body", message: "The request is invalid." } };
const NOT_FOUND = { error: { code: "not_found", message: "Not found." } };

const startBody = z
  .object({
    target: z.string(),
    mode: z.enum(["computer", "person"]),
    journey: z.string(),
    pace: z.enum(["demo", "office", "real-time", "machine"]),
    seed: z.string().min(1),
    confirm: z.string(),
    api: z.string().optional(),
    headed: z.boolean().optional(),
  })
  .strict();

type Target = { name: string; api: string; web: string; host: string };

function studioRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 4; hop += 1) {
    if (existsSync(path.join(dir, "targets.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("studio root not found");
}

function readTargets(): Target[] {
  const file = JSON.parse(readFileSync(path.join(studioRoot(), "targets.json"), "utf8")) as { targets: Target[] };
  return file.targets;
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

export function createStudioApp(): Hono {
  const app = new Hono();

  app.get("/targets", (c) => c.json({ targets: readTargets() }));

  app.get("/journeys", (c) => c.json({ journeys: journeyIds() }));

  app.post("/runs", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json(INVALID, 400);
    }
    const parsed = startBody.safeParse(json);
    if (!parsed.success) return c.json(INVALID, 400);
    const body = parsed.data;
    const target = readTargets().find((item) => item.name === body.target);
    if (!target) return c.json(INVALID, 400);
    if (body.target === "production" ? body.confirm !== "production" : body.confirm !== "") {
      return c.json(INVALID, 400);
    }
    const api = body.api ?? target.api;
    const apiHost = hostOf(api);
    const webHost = hostOf(target.web);
    const targetHost = hostOf(target.api);
    if (!apiHost || !webHost || !targetHost || apiHost !== target.host || webHost !== target.host || targetHost !== target.host) {
      return c.json(INVALID, 400);
    }
    const run = createRun({
      target: body.target,
      journey: body.journey,
      pace: body.pace,
      seed: body.seed,
      api,
      web: target.web,
      mode: body.mode,
      headed: body.headed ?? false,
    });
    if (!run) return c.json(INVALID, 400);
    return c.json({ run: publicRun(run) }, 201);
  });

  app.post("/runs/:id/pause", (c) => {
    const run = pauseRun(c.req.param("id"));
    if (!run) return c.json(NOT_FOUND, 404);
    return c.json({ run: publicRun(run) });
  });

  app.post("/runs/:id/stop", (c) => {
    const run = stopRun(c.req.param("id"));
    if (!run) return c.json(NOT_FOUND, 404);
    return c.json({ run: publicRun(run) });
  });

  app.get("/runs/:id", (c) => {
    const run = getRun(c.req.param("id"));
    if (!run) return c.json(NOT_FOUND, 404);
    return c.json({ run: publicRun(run) });
  });

  app.get("/runs/:id/events", (c) => {
    const run = getRun(c.req.param("id"));
    if (!run) return c.json(NOT_FOUND, 404);
    return streamSSE(c, async (stream) => {
      let sent = 0;
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      while (open) {
        const current = getRun(c.req.param("id"));
        if (!current) break;
        while (sent < current.events.length) {
          const event = current.events[sent];
          sent += 1;
          if (!event) continue;
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        if (current.status === "stopped" && sent >= current.events.length) break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    });
  });

  return app;
}

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function tunnel(localPort: number, upstream: string): void {
  const split = upstream.lastIndexOf(":");
  const host = upstream.slice(0, split);
  const port = Number(upstream.slice(split + 1));
  createNetServer((socket) => {
    const remote = connect(port, host);
    const close = () => {
      socket.destroy();
      remote.destroy();
    };
    socket.on("error", close);
    remote.on("error", close);
    remote.on("connect", () => {
      socket.pipe(remote);
      remote.pipe(socket);
    });
  }).listen(localPort, "127.0.0.1");
}

function fileInside(root: string, urlPath: string): string | null {
  const relative = decodeURIComponent((urlPath.split("?")[0] ?? "/").replace(/^\/+/, ""));
  const file = path.resolve(root, relative);
  const base = path.resolve(root) + path.sep;
  if (file !== path.resolve(root) && !file.startsWith(base)) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

function sendFile(res: ServerResponse, file: string): void {
  const type = types[path.extname(file)] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("content-type", type);
  if (file.endsWith(".html")) res.setHeader("cache-control", "no-store");
  createReadStream(file).pipe(res);
}

async function listen(): Promise<void> {
  loadEnv();
  const origin = process.env.KEEL_STUDIO_ORIGIN ?? "http://127.0.0.1:4102";
  const url = new URL(origin);
  const root = studioRoot();
  const app = createStudioApp();
  const api = getRequestListener(app.fetch);
  const client = process.env.KEEL_STUDIO_STATIC;
  if (process.env.KEEL_TUNNEL_API) tunnel(4101, process.env.KEEL_TUNNEL_API);
  if (process.env.KEEL_TUNNEL_WEB) tunnel(4100, process.env.KEEL_TUNNEL_WEB);
  const vite = client
    ? null
    : await (async () => {
        const loaded = await import("vite");
        return loaded.createServer({
          root,
          configFile: path.join(root, "vite.config.ts"),
          server: { middlewareMode: true },
          appType: "custom",
        });
      })();
  const server = createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if (pathname === "/targets" || pathname === "/journeys" || pathname.startsWith("/runs")) {
      api(req, res);
      return;
    }
    if (client) {
      const file = fileInside(client, pathname) ?? path.join(client, "index.html");
      sendFile(res, file);
      return;
    }
    const dev = vite;
    if (!dev) return;
    dev.middlewares(req, res, () => {
      void (async () => {
        try {
          const html = await dev.transformIndexHtml(req.url ?? "/", readFileSync(path.join(root, "index.html"), "utf8"));
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(html);
        } catch (error) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : "Studio failed.");
        }
      })();
    });
  });
  server.listen(Number(url.port || 80), process.env.KEEL_BIND || url.hostname, () => {
    console.log(`studio ${origin}`);
  });
}

const called = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (called && fileURLToPath(import.meta.url) === called) {
  void listen();
}
