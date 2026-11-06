import { useSyncExternalStore } from "react";
import { api } from "../api.ts";
import type { Card } from "./board.ts";

type SearchState = { query: string; byQuery: Record<string, Card[]> };

let state: SearchState = { query: "", byQuery: {} };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const searchStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get(): SearchState {
    return state;
  },
  setQuery(query: string): void {
    if (query === state.query) return;
    state = { ...state, query };
    emit();
  },
  has(query: string): boolean {
    return Object.prototype.hasOwnProperty.call(state.byQuery, query);
  },
  async fetch(query: string): Promise<void> {
    if (this.has(query)) return;
    const body = await api.search(query);
    state = { ...state, byQuery: { ...state.byQuery, [body.query]: body.cards } };
    emit();
  },
};

export function useSearch(): SearchState {
  return useSyncExternalStore(searchStore.subscribe, searchStore.get);
}
