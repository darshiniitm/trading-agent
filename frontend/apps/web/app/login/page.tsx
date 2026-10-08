"use client";
import { useState } from "react";
import { Card } from "@/ui/Card";
import { FieldText } from "@/ui/Fields";
import { Button } from "@/ui/Button";
import { Banner } from "@/ui/Banner";
import styles from "../auth.module.css";

export default function LoginPage() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState<string | null>(null);
  async function submit() { const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); if (!res.ok) { setError("invalid email or password"); return; } window.location.href = "/"; }
  return (
    <main className={styles.wrap}>
      <Card title="Sign in">
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <FieldText label="Email" aria-label="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <FieldText label="Password" aria-label="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button variant="primary" size={44} type="submit">Sign in</Button>
        </form>
        {error && <Banner tone="warn" role="alert">{error}</Banner>}
        <p className={styles.foot}><a href="/signup">Create an account</a></p>
      </Card>
    </main>
  );
}
