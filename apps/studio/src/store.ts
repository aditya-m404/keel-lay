export type Target = { name: string; api: string; web: string; host: string };

export type JourneyChoice = {
  id: string;
  title: string;
  actor: string;
  metrics: string[];
  steps: { id: string; method: string; path: string; thinkMs: { min: number; max: number } }[];
};

export type AccountSlot = {
  name: "application" | "infrastructure";
  configured: boolean;
  site: string;
  usesApplication?: boolean;
};

export type AccountCatalog = {
  vendor: string;
  application: AccountSlot;
  infrastructure: AccountSlot;
};

export type RunEvent = {
  at: string;
  actor: string;
  step: string;
  status: number;
  errorCount: number;
};

export type LiveRun = {
  id: string;
  scale: number;
  actors: number;
  status: string;
  events: RunEvent[];
};

type State = {
  targets: Target[];
  journeys: JourneyChoice[];
  accounts: AccountCatalog | null;
  live: LiveRun | null;
  error: string;
};

const listeners = new Set<() => void>();

let state: State = { targets: [], journeys: [], accounts: null, live: null, error: "" };

function emit(): void {
  for (const listener of listeners) listener();
}

export const runStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): State {
    return state;
  },
  setCatalog(targets: Target[], journeys: JourneyChoice[], accounts: AccountCatalog | null): void {
    state = { ...state, targets, journeys, accounts };
    emit();
  },
  setError(error: string): void {
    state = { ...state, error };
    emit();
  },
  start(run: { id: string; scale: number; actors: number; status: string }): void {
    state = { ...state, error: "", live: { ...run, events: [] } };
    emit();
  },
  append(event: RunEvent): void {
    if (!state.live) return;
    state = { ...state, live: { ...state.live, events: [...state.live.events, event] } };
    emit();
  },
  setStatus(status: string): void {
    if (!state.live) return;
    state = { ...state, live: { ...state.live, status } };
    emit();
  },
};
