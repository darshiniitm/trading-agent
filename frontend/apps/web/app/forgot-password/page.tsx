"use client";
import { useState } from "react";
import { Card } from "@/ui/Card";
import { FieldText } from "@/ui/Fields";
import { Button } from "@/ui/Button";
import { Banner } from "@/ui/Banner";
import { Captcha, captchaOptions, captchaBlocked } from "@/components/Captcha";
import { AUTH_ERRORS } from "@/lib/authRedirect";
import { authConfigured, createSupabaseBrowser } from "@/lib/supabase/browser";
import { forgotSchema, firstError } from "@/lib/authSchemas";
import styles from "../auth.module.css";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState(""); const [error, setError] = useState<string | null>(null); const [captcha, setCaptcha] = useState<string | null>(null); const [done, setDone] = useState(false);
  async function submit() {
    if (!authConfigured) { setError(AUTH_ERRORS.not_configured); return; }
    const parsed = forgotSchema.safeParse({ email });
    if (!parsed.success) { setError(firstError(parsed)); return; }
    if (captchaBlocked(captcha)) { setError("Complete the check below first"); return; }
    await createSupabaseBrowser().auth.resetPasswordForEmail(parsed.data.email, { redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`, ...captchaOptions(captcha) });
    setDone(true);   // same answer whether or not the email exists
  }
  return (
    <main className={styles.wrap}>
      <Card title="Reset your password">
        {done ? <p>If that email can be used, we've sent a link to reset your password.</p> : (
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <FieldText label="Email" aria-label="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Captcha onToken={setCaptcha} />
            <Button variant="primary" size={44} type="submit">Send reset link</Button>
          </form>
        )}
        {error && <Banner tone="warn" role="alert">{error}</Banner>}
        <p className={styles.foot}><a href="/login">Back to sign in</a></p>
      </Card>
    </main>
  );
}
