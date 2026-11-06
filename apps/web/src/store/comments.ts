import { useSyncExternalStore } from "react";

export type Comment = {
  id: string;
  cardId: string;
  body: string;
  authorId: string;
  createdAt: string;
};

type Thread = { loaded: boolean; comments: Comment[] };

let threads: Record<string, Thread> = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const commentStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get(cardId: string): Thread | null {
    return threads[cardId] ?? null;
  },
  isLoaded(cardId: string): boolean {
    return threads[cardId]?.loaded === true;
  },
  set(cardId: string, comments: Comment[]): void {
    threads = { ...threads, [cardId]: { loaded: true, comments } };
    emit();
  },
  append(comment: Comment): void {
    const current = threads[comment.cardId] ?? { loaded: true, comments: [] };
    if (current.comments.some((item) => item.id === comment.id)) return;
    threads = {
      ...threads,
      [comment.cardId]: { loaded: true, comments: [...current.comments, comment] },
    };
    emit();
  },
  merge(comments: Comment[]): void {
    if (comments.length === 0) return;
    let next = threads;
    for (const comment of comments) {
      const current = next[comment.cardId];
      if (!current?.loaded) continue;
      if (current.comments.some((item) => item.id === comment.id)) continue;
      next = {
        ...next,
        [comment.cardId]: { loaded: true, comments: [...current.comments, comment] },
      };
    }
    if (next === threads) return;
    threads = next;
    emit();
  },
};

export function useComments(cardId: string): Thread | null {
  return useSyncExternalStore(commentStore.subscribe, () => commentStore.get(cardId));
}
