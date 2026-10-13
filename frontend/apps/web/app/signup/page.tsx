"use client";
import { useState } from "react";
import { Card } from "@/ui/Card";
import { FieldText } from "@/ui/Fields";
import { Button } from "@/ui/Button";
import { Banner } from "@/ui/Banner";
import { OAuthButtons } from "@/components/OAuthButtons";
import { Captcha, captchaOptions, captchaBlocked } from "@/components/Captcha";
import { AUTH_ERRORS } from "@/lib/authRedirect";
import { authConfigured, createSupabaseBrowser } from "@/lib/supabase/browser";
import { signupSchema, firstError } from "@/lib/authSchemas";
import styles from "../auth.module.css";

export default function SignupPage() {
  const [f, setF] = useState({ displayName: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit() {
    if (!authConfigured) { setError(AUTH_ERRORS.not_configured); return; }
    const parsed = signupSchema.safeParse(f);
    if (!parsed.success) { setError(firstError(parsed)); return; }
    if (captchaBlocked(captcha)) { setError("Complete the check below first"); return; }
    setError(null);
    const { email, password, displayName } = parsed.data;
    const { error: err } = await createSupabaseBrowser().auth.signUp({
      email, password,
      options: { ...captchaOptions(captcha), data: { display_name: displayName }, emailRedirectTo: `${window.location.origin}/auth/callback?next=/prompts` },
    });
    // An already-registered email returns no error either; the screen is the same neutral one so emails can't be probed.
    if (err && !/already|registered/i.test(err.message)) { setError("Couldn't create the account. Please try again."); return; }
    setSent(email);
  }
  async function resend() {
    if (sent && authConfigured) await createSupabaseBrowser().auth.resend({ type: "signup", email: sent, options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/prompts` } });
  }

  if (sent) return (
    <main className={styles.wrap}>
      <Card title="Check your inbox">
        <p>If <strong>{sent}</strong> can be used, we've sent a confirmation link. Click it to finish creating your account.</p>
        <Button size={40} onClick={() => void resend()}>Resend email</Button>
        <p className={styles.foot}><a href="/login">Back to sign in</a></p>
      </Card>
    </main>
  );
  return (
    <main className={styles.wrap}>
      <Card title="Create an account">
        <OAuthButtons onError={setError} />
        <div className={styles.divider}>or</div>
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <FieldText label="Name" aria-label="display name" autoComplete="name" value={f.displayName} onChange={set("displayName")} />
          <FieldText label="Email" aria-label="email" type="email" autoComplete="email" value={f.email} onChange={set("email")} />
          <FieldText label="Password" aria-label="password" type="password" autoComplete="new-password" value={f.password} onChange={set("password")} />
          <FieldText label="Confirm password" aria-label="confirm password" type="password" autoComplete="new-password" value={f.confirm} onChange={set("confirm")} />
          <Captcha onToken={setCaptcha} />
          <Button variant="primary" size={44} type="submit">Create account</Button>
        </form>
        {error && <Banner tone="warn" role="alert">{error}</Banner>}
        <p className={styles.foot}><a href="/login">Already have an account? Sign in</a></p>
      </Card>
    </main>
  );
}
