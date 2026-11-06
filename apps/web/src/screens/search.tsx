import { useEffect } from "react";
import { Link } from "react-router";
import { searchStore, useSearch } from "../store/search.ts";

export function SearchBox() {
  const { query, byQuery } = useSearch();
  const trimmed = query.trim();
  const results = trimmed ? byQuery[trimmed] ?? [] : [];

  useEffect(() => {
    if (trimmed.length < 1 || trimmed.length > 80) return;
    if (searchStore.has(trimmed)) return;
    const timer = window.setTimeout(() => {
      void searchStore.fetch(trimmed);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [trimmed]);

  return (
    <form className="search" role="search" onSubmit={(event) => event.preventDefault()}>
      <label>
        Search
        <input value={query} onChange={(event) => searchStore.setQuery(event.target.value)} />
      </label>
      {trimmed && results.length > 0 ? (
        <ul className="search-results">
          {results.map((card) => (
            <li key={card.id}>
              <Link to={`/boards/${card.boardId}/cards/${card.id}`}>{card.title}</Link>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

export function SearchPage() {
  const { query, byQuery } = useSearch();
  const trimmed = query.trim();
  const results = trimmed ? byQuery[trimmed] ?? [] : [];
  return (
    <section className="search-page">
      <h1>Search</h1>
      {trimmed ? (
        <ul className="results">
          {results.map((card) => (
            <li key={card.id}>
              <Link to={`/boards/${card.boardId}/cards/${card.id}`}>{card.title}</Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>Type in the search field.</p>
      )}
    </section>
  );
}
