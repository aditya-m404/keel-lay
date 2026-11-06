import type { Card } from "@keel/contracts/board";
import type { Comment } from "@keel/contracts/writes";

export type CardRow = {
  id: string;
  title: string;
  column: Card["column"];
  position: number;
  author_id: string;
  version: string;
  created_at: Date;
  updated_at: Date;
};

export type CommentRow = {
  id: string;
  card_id: string;
  body: string;
  author_id: string;
  created_at: Date;
};

export const CARD_SELECT = `id, title, "column", position, author_id, version::text AS version, created_at, updated_at`;

export function mapCard(row: CardRow): Card {
  return {
    id: row.id,
    boardId: "launch",
    title: row.title,
    column: row.column,
    position: Number(row.position),
    authorId: row.author_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: Number(row.version),
  };
}

export function mapComment(row: CommentRow): Comment {
  return {
    id: row.id,
    cardId: row.card_id,
    body: row.body,
    authorId: row.author_id,
    createdAt: row.created_at.toISOString(),
  };
}
