const vendor = (process.env.KEEL_COLLECTOR_VENDOR ?? "").trim();

function headers(key: string): Record<string, string> {
  const sent: Record<string, string> = { "content-type": "application/json" };
  if (vendor === "datadog") sent["dd-api-key"] = key;
  else if (vendor === "sentry") sent["x-sentry-auth"] = key;
  else sent.authorization = key;
  return sent;
}

function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function body(signal: "app" | "infra", kind: "traces" | "logs" | "metrics"): string {
  const resource = [attribute("service.name", "keel-doctor"), attribute("keel.signal", signal)];
  const now = String(BigInt(Date.now()) * 1_000_000n);
  if (kind === "traces") {
    return JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: resource },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "0123456789abcdef0123456789abcdef",
                  spanId: "0123456789abcdef",
                  name: "doctor",
                  kind: 1,
                  startTimeUnixNano: now,
                  endTimeUnixNano: now,
                  attributes: [attribute("keel.signal", signal)],
                },
              ],
            },
          ],
        },
      ],
    });
  }
  if (kind === "logs") {
    return JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: resource },
          scopeLogs: [{ logRecords: [{ timeUnixNano: now, body: { stringValue: "doctor" }, attributes: [attribute("keel.signal", signal)] } }] }],
        },
      ],
    });
  }
  return JSON.stringify({
    resourceMetrics: [
      {
        resource: { attributes: resource },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "keel.doctor.sample",
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [{ asInt: "1", timeUnixNano: now, attributes: [attribute("keel.signal", signal)] }],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

async function probe(endpoint: string, key: string, signal: "app" | "infra", kind: "metrics" | "logs" | "traces"): Promise<string> {
  const path = kind === "metrics" ? "/v1/metrics" : kind === "logs" ? "/v1/logs" : "/v1/traces";
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: headers(key),
      body: body(signal, kind),
      signal: AbortSignal.timeout(4000),
    });
    return response.ok ? "accepted" : "refused";
  } catch {
    return "refused";
  }
}

const slots = [
  ["app", process.env.KEEL_VENDOR_APP_ENDPOINT ?? "", process.env.KEEL_VENDOR_APP_API_KEY ?? ""],
  ["infra", process.env.KEEL_VENDOR_INFRA_ENDPOINT ?? "", process.env.KEEL_VENDOR_INFRA_API_KEY ?? ""],
] as const;

const parts: string[] = [];
for (const [signal, endpoint, key] of slots) {
  for (const kind of ["metrics", "logs", "traces"] as const) {
    const result = await probe(endpoint, key, signal, kind);
    parts.push(`${signal} ${kind} ${result}`);
  }
}
console.log(parts.join(", "));
