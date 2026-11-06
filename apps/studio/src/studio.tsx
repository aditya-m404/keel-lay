import { useEffect, useState, useSyncExternalStore } from "react";
import { runStore, type AccountCatalog, type AccountSlot, type JourneyChoice, type RunEvent, type Target } from "./store.ts";

const paces = ["demo", "office", "real-time", "machine"] as const;

const modes = ["computer", "person"] as const;

type People = "seeded" | "fresh" | "metrics";

type StartBody = {
  target: string;
  mode: (typeof modes)[number];
  journey: string;
  pace: (typeof paces)[number];
  seed: string;
  confirm: string;
  people: People;
  accounts: ("application" | "infrastructure")[];
  metricCount: number;
  intervalMs: number;
};

const cast: Record<string, string> = {
  ada: "Ada, the owner",
  grace: "Grace, a member",
  linus: "Linus, a viewer",
};

const modeCopy: Record<(typeof modes)[number], { label: string; hint: string }> = {
  computer: {
    label: "Computer — calls the API",
    hint: "Studio signs in and sends the requests. Office pace can use three people.",
  },
  person: {
    label: "Person — a browser clicks",
    hint: "A hidden browser signs in and clicks the board as one person. Open the board to watch the result.",
  },
};

const paceCopy: Record<(typeof paces)[number], { label: string; hint: string }> = {
  demo: {
    label: "Demo — slow, one person, about 3 minutes",
    hint: "Pauses last about ten times longer, so the journey is easy to watch.",
  },
  office: {
    label: "Office — slow, three people, about 15 minutes",
    hint: "A workday shape. Person mode still uses one browser.",
  },
  "real-time": {
    label: "Real time — three people, about 30 minutes",
    hint: "Pauses run at the recorded speed.",
  },
  machine: {
    label: "Machine — real time, one person, about 10 minutes",
    hint: "The shortest pass at the recorded speed.",
  },
};

function targetLabel(name: string): string {
  if (name === "local") return "This machine (local)";
  if (name === "local-prod") return "Packaged copy (local-prod)";
  if (name === "production") return "Live server (production)";
  return name;
}

function targetHint(item: Target | undefined): string {
  if (!item) return "Choose which copy of the board this rehearsal writes to.";
  if (item.name === "local") return `The board on this machine, ${item.web}.`;
  if (item.name === "local-prod") return `The packaged board, ${item.web}. This is the copy that behaves like a deploy.`;
  if (item.name === "production") return `The live board, ${item.web}. Type production below or Studio refuses the run.`;
  return item.web;
}

function asJourneys(value: unknown): JourneyChoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Partial<JourneyChoice>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) return [];
    return [{
      id,
      title: typeof record.title === "string" && record.title ? record.title : id,
      actor: typeof record.actor === "string" ? record.actor : "",
      metrics: Array.isArray(record.metrics) ? record.metrics.filter((name): name is string => typeof name === "string") : [],
      steps: Array.isArray(record.steps) ? record.steps : [],
    }];
  });
}

function metricFor(method: string, stepPath: string): string | null {
  if (method === "POST" && stepPath === "/cards") return "keel.card.created";
  if (method === "POST" && stepPath.endsWith("/comments")) return "keel.comment.created";
  if (method === "POST" && stepPath.endsWith("/stars")) return "keel.card.starred";
  if (method === "PATCH" && stepPath.startsWith("/cards/")) return "keel.card.moved";
  return null;
}

function formatGap(ms: number): string {
  if (ms < 1000) return `every ${ms} ms`;
  const seconds = Math.round(ms / 100) / 10;
  return `every ${seconds} s`;
}

function metricRows(
  journey: JourneyChoice | undefined,
  scale: number,
  actors: number,
  people: People,
  count: number,
  intervalMs: number,
): { name: string; count: number; intervalMs: number }[] {
  if (!journey) return [];
  if (people === "metrics") {
    const names = journey.metrics.length ? journey.metrics : ["http.server.requests"];
    return names.map((name) => ({ name, count, intervalMs }));
  }
  const rows = new Map<string, { name: string; count: number; intervalMs: number }>();
  for (const step of journey.steps) {
    const name = metricFor(step.method, step.path);
    if (!name) continue;
    const gap = Math.max(200, Math.round(((step.thinkMs.min + step.thinkMs.max) / 2) / scale));
    const row = rows.get(name) ?? { name, count: 0, intervalMs: gap };
    row.count += actors;
    rows.set(name, row);
  }
  if (rows.size === 0) {
    const gap = journey.steps[0]
      ? Math.max(200, Math.round(((journey.steps[0].thinkMs.min + journey.steps[0].thinkMs.max) / 2) / scale))
      : 1000;
    return [{ name: "http.server.requests", count: Math.max(1, journey.steps.length * actors), intervalMs: gap }];
  }
  return [...rows.values()];
}

function accountLine(slot: AccountSlot | undefined, fallback: string): string {
  if (!slot) return fallback;
  if (slot.usesApplication) return "No separate infrastructure account. Machine metrics use the application account.";
  if (!slot.configured) return "Not configured. This pipeline stays in the collector log.";
  return slot.site ? `Configured. Org ${slot.site}.` : "Configured.";
}

export function Studio() {
  const snapshot = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot, runStore.getSnapshot);
  const [target, setTarget] = useState("local");
  const [mode, setMode] = useState<(typeof modes)[number]>("computer");
  const [journey, setJourney] = useState("create-card");
  const [pace, setPace] = useState<(typeof paces)[number]>("demo");
  const [seed, setSeed] = useState("phase7-seed");
  const [confirm, setConfirm] = useState("");
  const [people, setPeople] = useState<People>("seeded");
  const [application, setApplication] = useState(true);
  const [infrastructure, setInfrastructure] = useState(false);
  const [metricCount, setMetricCount] = useState(5);
  const [intervalSeconds, setIntervalSeconds] = useState(2);

  useEffect(() => {
    let cancel = false;
    void Promise.all([
      fetch("/targets", { headers: { accept: "application/json" } }).then((response) => response.json()),
      fetch("/journeys", { headers: { accept: "application/json" } }).then((response) => response.json()),
      fetch("/accounts", { headers: { accept: "application/json" } }).then((response) => response.json()),
    ]).then(([targetsBody, journeysBody, accountsBody]) => {
      if (cancel) return;
      runStore.setCatalog(targetsBody.targets ?? [], asJourneys(journeysBody.journeys), accountsBody as AccountCatalog);
    });
    return () => {
      cancel = true;
    };
  }, []);

  const choices = snapshot.journeys.length
    ? snapshot.journeys
    : [{ id: "create-card", title: "create-card", actor: "grace", metrics: ["keel.card.created"], steps: [] }];
  const chosen = choices.find((item) => item.id === journey) ?? choices[0];
  const selectedTarget = snapshot.targets.find((item) => item.name === target);
  const where = target === "local" ? "the board on this machine" : target === "local-prod" ? "the packaged board" : target === "production" ? "the live server" : target;
  const scale = pace === "demo" || pace === "office" ? 10 : 1;
  const actors = mode === "person" || target === "production" ? 1 : pace === "office" || pace === "real-time" ? 3 : 1;
  const accounts = [
    ...(application ? ["application" as const] : []),
    ...(infrastructure ? ["infrastructure" as const] : []),
  ];
  const rows = metricRows(chosen, scale, actors, people, metricCount, intervalSeconds * 1000);
  const who = people === "seeded"
    ? `Signs in as ${cast[chosen?.actor ?? ""] ?? "a seeded person"}, already on the board.`
    : people === "fresh"
      ? "Signs up a new member for this run, then plays the story as that person."
      : `Signs nobody in. Sends ${metricCount} ${metricCount === 1 ? "point" : "points"} of each metric ${formatGap(intervalSeconds * 1000)}.`;
  const landing = accounts.length === 2
    ? "Board numbers go to the application account with the run id. Machine numbers go to the infrastructure account without it."
    : accounts[0] === "infrastructure"
      ? "Numbers go to the infrastructure account, without a run id."
      : "Numbers go to the application account, with the run id.";

  async function start(): Promise<void> {
    const sentConfirm = target === "production" ? confirm : "";
    if (target === "production" && sentConfirm !== "production") {
      runStore.setError("Type production in Confirm. Anything else is refused.");
      return;
    }
    if (accounts.length === 0) {
      runStore.setError("Pick the application account, the infrastructure account, or both.");
      return;
    }
    if (people !== "seeded" && mode === "person") {
      runStore.setError("A browser run uses the seeded people. Pick Computer for a new account or for metrics only.");
      return;
    }
    const body: StartBody = {
      target,
      mode,
      journey,
      pace,
      seed,
      confirm: sentConfirm,
      people,
      accounts,
      metricCount: people === "metrics" ? metricCount : rows.reduce((sum, row) => sum + row.count, 0) || 1,
      intervalMs: people === "metrics" ? intervalSeconds * 1000 : rows[0]?.intervalMs || 1000,
    };
    const response = await fetch("/runs", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok) {
      runStore.setError(json.error?.message ?? "The run was refused.");
      return;
    }
    const run = json.run as { id: string; scale: number; actors: number; status: string };
    runStore.start(run);
    const source = new EventSource(`/runs/${run.id}/events`);
    source.onmessage = (message) => {
      runStore.append(JSON.parse(message.data) as RunEvent);
    };
    source.onerror = () => {
      source.close();
      void fetch(`/runs/${run.id}`, { headers: { accept: "application/json" } })
        .then((next) => next.json())
        .then((body) => {
          if (body.run?.status) runStore.setStatus(body.run.status);
        })
        .catch(() => undefined);
    };
  }

  async function control(action: "pause" | "stop"): Promise<void> {
    const live = runStore.getSnapshot().live;
    if (!live) return;
    const response = await fetch(`/runs/${live.id}/${action}`, { method: "POST", headers: { accept: "application/json" } });
    const json = await response.json();
    if (response.ok) runStore.setStatus(json.run.status);
  }

  const live = snapshot.live;
  const latest = live?.events.at(-1);

  return (
    <main className="studio">
      <header className="top">
        <h1>Studio</h1>
        <p>Drive a copy of the board. Choose the people, the account that stores the numbers, and how often those numbers are sent.</p>
      </header>
      <p className="brief">{`“${chosen?.title ?? journey}” on ${where}. ${who} ${landing}`}</p>
      <form className="controls" onSubmit={(event) => event.preventDefault()}>
        <div className="field">
          <label htmlFor="target">Target</label>
          <select id="target" name="target" value={target} onChange={(event) => { runStore.setError(""); setTarget(event.target.value); }}>
            {(snapshot.targets.length ? snapshot.targets : [{ name: "local" }]).map((item) => (
              <option key={item.name} value={item.name}>{targetLabel(item.name)}</option>
            ))}
          </select>
          <p id="target-hint" className="hint">{targetHint(selectedTarget)}</p>
        </div>
        <div className="field">
          <label htmlFor="mode">Mode</label>
          <select id="mode" name="mode" value={mode} onChange={(event) => { runStore.setError(""); setMode(event.target.value as (typeof modes)[number]); }}>
            {modes.map((id) => (
              <option key={id} value={id} disabled={id === "person" && people !== "seeded"}>{modeCopy[id].label}</option>
            ))}
          </select>
          <p className="hint">{people === "seeded" ? modeCopy[mode].hint : "A new account and a metrics-only run call the API. The browser journey still types an existing email."}</p>
        </div>
        <fieldset className="field span">
          <legend>People</legend>
          <label className="choice">
            <input type="radio" name="people" value="seeded" checked={people === "seeded"} onChange={() => { runStore.setError(""); setPeople("seeded"); }} />
            <span><strong>Already on the board.</strong> Ada, Grace, and Linus. This story signs in as {cast[chosen?.actor ?? ""] ?? "one of them"}.</span>
          </label>
          <label className="choice">
            <input type="radio" name="people" value="fresh" checked={people === "fresh"} onChange={() => { runStore.setError(""); setPeople("fresh"); setMode("computer"); }} />
            <span><strong>New account each run.</strong> Computer mode signs up a new member, then plays the story as that person. Nothing is reused from the cast.</span>
          </label>
          <label className="choice">
            <input type="radio" name="people" value="metrics" checked={people === "metrics"} onChange={() => { runStore.setError(""); setPeople("metrics"); setMode("computer"); }} />
            <span><strong>No accounts.</strong> Nobody signs in and the board is left alone. Studio sends only the metrics, at the count and interval below.</span>
          </label>
          <p className="hint">Already on the board is the seeded cast. A new account is created for that run only.</p>
        </fieldset>
        <fieldset className="field span">
          <legend>Accounts</legend>
          <label className="choice">
            <input type="checkbox" checked={application} onChange={(event) => { runStore.setError(""); setApplication(event.target.checked); }} />
            <span><strong>Application.</strong> The product account. Board metrics keep the run id. {accountLine(snapshot.accounts?.application, "Loading the application account.")}</span>
          </label>
          <label className="choice">
            <input type="checkbox" checked={infrastructure} onChange={(event) => { runStore.setError(""); setInfrastructure(event.target.checked); }} />
            <span><strong>Infrastructure.</strong> The machines account. Metrics here do not carry the run id. {accountLine(snapshot.accounts?.infrastructure, "Loading the infrastructure account.")}</span>
          </label>
          <p className="hint">{snapshot.accounts?.vendor === "openobserve" ? "OpenObserve is the store. A run id in the application account, and missing from the infrastructure account, is the finished story." : "No cloud vendor is selected. Both pipelines stay in the collector log."}</p>
        </fieldset>
        <div className="field">
          <label htmlFor="journey">Journey</label>
          <select id="journey" name="journey" value={journey} onChange={(event) => { runStore.setError(""); setJourney(event.target.value); }}>
            {choices.map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </select>
          <p className="hint">The story this run will play.</p>
        </div>
        <div className="field">
          <label htmlFor="pace">Pace</label>
          <select id="pace" name="pace" value={pace} onChange={(event) => { runStore.setError(""); setPace(event.target.value as (typeof paces)[number]); }}>
            {paces.map((id) => (
              <option key={id} value={id}>{paceCopy[id].label}</option>
            ))}
          </select>
          <p className="hint">{paceCopy[pace].hint}</p>
        </div>
        <div className="field span">
          <p className="name">Metrics</p>
          <table className="metrics">
            <thead>
              <tr><th>Metric</th><th>Count</th><th>Interval</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{row.count}</td>
                  <td>{formatGap(row.intervalMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {people === "metrics" ? (
            <div className="pair">
              <label>
                Count
                <input id="count" type="number" min={1} max={100} value={metricCount} onChange={(event) => setMetricCount(Math.min(100, Math.max(1, Number(event.target.value) || 1)))} />
              </label>
              <label>
                Interval
                <input id="interval" type="number" min={1} max={60} value={intervalSeconds} onChange={(event) => setIntervalSeconds(Math.min(60, Math.max(1, Number(event.target.value) || 1)))} />
              </label>
            </div>
          ) : null}
          <p className="hint">{people === "metrics" ? "Count is how many points of each metric are sent. Interval is the real wait in seconds. Pace does not stretch it." : "Count is how many times the story emits that metric. Interval is the pause before that step, already divided by the time scale."}</p>
        </div>
        <div className="field">
          <label htmlFor="seed">Seed</label>
          <input id="seed" name="seed" value={seed} onChange={(event) => setSeed(event.target.value)} />
          <p className="hint">A name for this rehearsal. The same seed repeats the same pauses. It is not a password.</p>
        </div>
        {target === "production" ? (
          <div className="field">
            <label htmlFor="confirm">Confirm</label>
            <input
              id="confirm"
              name="confirm"
              value={confirm}
              placeholder="production"
              onChange={(event) => setConfirm(event.target.value)}
            />
            <p className="hint">Type the word production. Studio refuses a live run until this matches.</p>
          </div>
        ) : (
          <div className="field">
            <p className="name">Confirm</p>
            <p className="hint">Left empty on purpose. Only the live server asks you to type production. A word like yes is refused.</p>
          </div>
        )}
        <div className="actions">
          <button type="button" onClick={() => void start()}>Start</button>
          <button type="button" className="ghost" onClick={() => void control("pause")} disabled={!live}>Pause</button>
          <button type="button" className="ghost" onClick={() => void control("stop")} disabled={!live}>Stop</button>
          <p className="hint">Start plays the journey. Pause holds the clock. Stop ends the session and leaves cards already written.</p>
        </div>
      </form>
      {snapshot.error ? <p className="alert" role="alert">{snapshot.error}</p> : null}
      {live ? (
        <section className="strip" aria-label="Live run">
          <h2>This run</h2>
          <dl>
            <div>
              <dt>Run</dt>
              <dd data-run="">{live.id}</dd>
            </div>
            <div>
              <dt>Time scale</dt>
              <dd data-scale="">{live.scale}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{live.status}</dd>
            </div>
            <div>
              <dt>Who</dt>
              <dd>{latest?.actor ?? `${live.actors} ready`}</dd>
            </div>
            <div>
              <dt>Step</dt>
              <dd>{latest?.step ?? "starting"}</dd>
            </div>
            <div>
              <dt>Errors</dt>
              <dd>{latest?.errorCount ?? 0}</dd>
            </div>
          </dl>
          <p className="hint">
            {live.scale === 1
              ? "Time scale 1 means pauses run at the recorded speed."
              : `Time scale ${live.scale} means each pause lasts ${live.scale} times longer.`}
          </p>
        </section>
      ) : null}
    </main>
  );
}
