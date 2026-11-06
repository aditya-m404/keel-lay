import { useEffect, useState, useSyncExternalStore } from "react";
import { runStore, type RunEvent } from "./store.ts";

const paces = ["demo", "office", "real-time", "machine"] as const;

const modes = ["computer", "person"] as const;

type StartBody = {
  target: string;
  mode: (typeof modes)[number];
  journey: string;
  pace: (typeof paces)[number];
  seed: string;
  confirm: string;
};

export function Studio() {
  const snapshot = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot, runStore.getSnapshot);
  const [target, setTarget] = useState("local");
  const [mode, setMode] = useState<(typeof modes)[number]>("computer");
  const [journey, setJourney] = useState("create-card");
  const [pace, setPace] = useState<(typeof paces)[number]>("demo");
  const [seed, setSeed] = useState("phase7-seed");
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    let cancel = false;
    void Promise.all([
      fetch("/targets", { headers: { accept: "application/json" } }).then((response) => response.json()),
      fetch("/journeys", { headers: { accept: "application/json" } }).then((response) => response.json()),
    ]).then(([targetsBody, journeysBody]) => {
      if (cancel) return;
      runStore.setCatalog(targetsBody.targets ?? [], journeysBody.journeys ?? []);
    });
    return () => {
      cancel = true;
    };
  }, []);

  async function start(): Promise<void> {
    const body: StartBody = { target, mode, journey, pace, seed, confirm };
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
        <p>Rehearse the board. This screen stays on the machine side.</p>
      </header>
      <form className="controls" onSubmit={(event) => event.preventDefault()}>
        <label>
          Target
          <select name="target" value={target} onChange={(event) => setTarget(event.target.value)}>
            {(snapshot.targets.length ? snapshot.targets : [{ name: "local" }]).map((item) => (
              <option key={item.name} value={item.name}>{item.name}</option>
            ))}
          </select>
        </label>
        <label>
          Mode
          <select name="mode" value={mode} onChange={(event) => setMode(event.target.value as (typeof modes)[number])}>
            {modes.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
        <label>
          Journey
          <select name="journey" value={journey} onChange={(event) => setJourney(event.target.value)}>
            {(snapshot.journeys.length ? snapshot.journeys : ["create-card"]).map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
        <label>
          Pace
          <select name="pace" value={pace} onChange={(event) => setPace(event.target.value as (typeof paces)[number])}>
            {paces.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
        <label>
          Seed
          <input name="seed" value={seed} onChange={(event) => setSeed(event.target.value)} />
        </label>
        <label>
          Confirm
          <input name="confirm" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        </label>
        <div className="actions">
          <button type="button" onClick={() => void start()}>Start</button>
          <button type="button" onClick={() => void control("pause")} disabled={!live}>Pause</button>
          <button type="button" onClick={() => void control("stop")} disabled={!live}>Stop</button>
        </div>
      </form>
      {snapshot.error ? <p className="alert" role="alert">{snapshot.error}</p> : null}
      {live ? (
        <section className="strip" aria-label="Live run">
          <p>
            <span data-run="">{live.id}</span>
            <span data-scale="">{live.scale}</span>
          </p>
          <p>
            <span>{latest?.actor ?? live.actors}</span>
            <span>{latest?.step ?? "starting"}</span>
            <span>{latest?.errorCount ?? 0}</span>
            <span>{live.status}</span>
          </p>
        </section>
      ) : null}
    </main>
  );
}
