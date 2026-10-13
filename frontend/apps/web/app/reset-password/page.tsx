"use client";
import { useState } from "react";
import { Card } from "@/ui/Card";
import { FieldText } from "@/ui/Fields";
import { Button } from "@/ui/Button";
import { Banner } from "@/ui/Banner";
import { AUTH_ERRORS } from "@/lib/authRedirect";
import { authConfigured, createSupabaseBrowser } from "@/lib/supabase/browser";
import { resetSchema, firstError } from "@/lib/authSchemas";
import styles from "../auth.module.css";

// Reached through the recovery link: /auth/callback has already exchanged the code, so this page is signed in.
export default function ResetPasswordPage() {
  const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState(""); const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!authConfigured) { setError(AUTH_ERRORS.not_configured); return; }
    const parsed = resetSchema.safeParse({ password, confirm });
    if (!parsed.success) { setError(firstError(parsed)); return; }
    const { error: err } = await createSupabaseBrowser().auth.updateUser({ password: parsed.data.password });
    if (err) { setError("Couldn't update the password. The link may have expired — request a new one."); return; }
    await fetch("/api/auth/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "password_reset" }) }).catch(() => {});
    window.location.href = "/prompts";
  }
  return (
    <main className={styles.wrap}>
      <Card title="Choose a new password">
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <FieldText label="New password" aria-label="new password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <FieldText label="Confirm password" aria-label="confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button variant="primary" size={44} type="submit">Update password</Button>
        </form>
        {error && <Banner tone="warn" role="alert">{error}</Banner>}
      </Card>
    </main>
  );
}
