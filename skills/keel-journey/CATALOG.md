# Journey catalog

One id, one file. Do not add a second file for an id that is already here.

| Id | File | Who | Ends as |
| --- | --- | --- | --- |
| sign-in | `packages/journeys/sign-in.yaml` | any | session cookie |
| read-board | `packages/journeys/read-board.yaml` | any | board read, no write |
| create-card | `packages/journeys/create-card.yaml` | member, owner | card on Todo |
| comment | `packages/journeys/comment.yaml` | member, owner | comment row |
| search | `packages/journeys/search.yaml` | any | result list includes the card |
| forbidden-move | `packages/journeys/forbidden-move.yaml` | viewer | 403 |

`move-card` and `invalid-card` are not files yet.
