"use client";
import { useState } from "react";
import { Card } from "@/ui/Card";
import { FieldText } from "@/ui/Fields";
import { Button } from "@/ui/Button";
import { Banner } from "@/ui/Banner";
import styles from "../auth.module.css";

export default function SignupPage() {
  const [displayName, setDisplayName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState<string | null>(null);
  async function submit() { const res = await fetch("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName, email, password }) }); const body = await res.json(); if (!res.ok) { setError(body.error ?? "could not create account"); return; } window.location.href = "/"; }
  return (
    <main className={styles.wrap}>
      <Card title="Create an account">
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <FieldText label="Name" aria-label="display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <FieldText label="Email" aria-label="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <FieldText label="Password" aria-label="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button variant="primary" size={44} type="submit">Create account</Button>
        </form>
        {error && <Banner tone="warn" role="alert">{error}</Banner>}
        <p className={styles.foot}><a href="/login">Already have an account? Sign in</a></p>
      </Card>
    </main>
  );
}
