import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api.ts";
import { sessionStore } from "../store/session.ts";

export function SignUp() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const body = await api.signUp(name.trim(), email.trim().toLowerCase(), password);
      sessionStore.setUser(body.user);
      navigate("/boards/launch");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The account could not be created.");
    }
  }

  return (
    <form className="gate" onSubmit={onSubmit}>
      <p className="mark">Keel</p>
      <h1>Create an account</h1>
      <p className="lede">You join the Launch board as a member and can add cards of your own.</p>
      <label>
        Name
        <input name="name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Email
        <input name="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <p className="hint">At least 8 characters.</p>
      {error ? <p className="alert" role="alert">{error}</p> : null}
      <button type="submit">Create account</button>
      <p className="switch">Already on the team? <Link to="/sign-in">Sign in</Link></p>
    </form>
  );
}
