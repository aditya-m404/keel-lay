import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.ts";
import { sessionStore } from "../store/session.ts";

export function SignIn() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const body = await api.signIn(email.trim().toLowerCase(), password);
      sessionStore.setUser(body.user);
      navigate("/boards/launch");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    }
  }

  return (
    <form className="sign-in" onSubmit={onSubmit}>
      <h1>Sign in</h1>
      <label>
        Email
        <input name="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit">Sign in</button>
    </form>
  );
}
