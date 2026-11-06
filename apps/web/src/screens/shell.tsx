import { Link, Outlet, useNavigate } from "react-router";
import { api } from "../api.ts";
import { sessionStore, useSession } from "../store/session.ts";
import { SearchBox } from "./search.tsx";

export function Shell() {
  const session = useSession();
  const navigate = useNavigate();

  async function signOut() {
    await api.signOut();
    sessionStore.clear();
    navigate("/sign-in");
  }

  return (
    <div className="app">
      <header className="top">
        <Link className="brand" to={session.status === "user" ? "/boards/launch" : "/sign-in"}>Keel</Link>
        {session.status === "user" ? (
          <>
            <SearchBox />
            <span className="who">{session.user.name}</span>
            <button type="button" onClick={() => void signOut()}>Sign out</button>
          </>
        ) : null}
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
