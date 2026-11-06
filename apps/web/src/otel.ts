declare global {
  interface Window {
    __KEEL_RUN__?: { id: string; actor: string; journey: string; pace: string; step: string };
    __KEEL_OTEL__?: { pending: number };
  }
}

function hex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function labelOf(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "click";
  const control = target.closest("button, a, [role='button']");
  const text = (control ?? target).textContent?.trim() ?? "";
  return text.slice(0, 80) || "click";
}

function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function sendClick(label: string): void {
  const run = window.__KEEL_RUN__;
  const now = BigInt(Date.now()) * 1_000_000n;
  const attributes = [attribute("keel.signal", "app"), attribute("click.label", label)];
  if (run?.id) attributes.push(attribute("keel.run_id", run.id));
  if (run?.actor) attributes.push(attribute("keel.actor", run.actor));
  if (run?.journey) attributes.push(attribute("keel.journey", run.journey));
  if (run?.step) attributes.push(attribute("keel.step", run.step));
  if (run?.pace) attributes.push(attribute("keel.pace", run.pace));
  const resource = [attribute("service.name", "keel-web"), attribute("keel.signal", "app")];
  if (run?.id) resource.push(attribute("keel.run_id", run.id));
  const body = {
    resourceSpans: [
      {
        resource: { attributes: resource },
        scopeSpans: [
          {
            scope: { name: "keel-web" },
            spans: [
              {
                traceId: hex(16),
                spanId: hex(8),
                name: "click",
                kind: 3,
                startTimeUnixNano: now.toString(),
                endTimeUnixNano: now.toString(),
                attributes,
              },
            ],
          },
        ],
      },
    ],
  };
  const tracker = (window.__KEEL_OTEL__ ??= { pending: 0 });
  tracker.pending += 1;
  void fetch("/otel", {
    method: "POST",
    credentials: "omit",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  })
    .catch(() => {})
    .finally(() => {
      tracker.pending -= 1;
    });
}

document.addEventListener(
  "click",
  (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("button, a, [role='button']")) return;
    sendClick(labelOf(target));
  },
  true,
);

export {};
