"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card } from "@/ui/Card";
import { FieldText } from "@/ui/Fields";
import { Button } from "@/ui/Button";
import { Banner } from "@/ui/Banner";
import { OAuthButtons } from "@/components/OAuthButtons";
import { Captcha, captchaOptions, captchaBlocked } from "@/components/Captcha";
import { authConfigured, createSupabaseBrowser } from "@/lib/supabase/browser";
import { AUTH_ERRORS, safeNext } from "@/lib/authRedirect";
import { loginSchema, firstError } from "@/lib/authSchemas";
import styles from "../auth.module.css";

function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next");
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(AUTH_ERRORS[params.get("error") ?? ""] ?? null);

  async function submit() {
    if (!authConfigured) { setError(AUTH_ERRORS.not_configured); return; }
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) { setError(firstError(parsed)); return; }
    if (captchaBlocked(captcha)) { setError("Complete the check below first"); return; }
    const { error: err } = await createSupabaseBrowser().auth.signInWithPassword({ ...parsed.data, options: captchaOptions(captcha) });
    if (err) { setError("Invalid email or password"); return; }   // same message for every failure: no enumeration
    window.location.href = safeNext(next);
  }
  return (
    <main className={styles.wrap}>
      <Card title="Sign in">
        <OAuthButtons next={next} onError={setError} />
        <div className={styles.divider}>or</div>
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <FieldText label="Email" aria-label="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <FieldText label="Password" aria-label="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Captcha onToken={setCaptcha} />
          <Button variant="primary" size={44} type="submit">Sign in</Button>
        </form>
        {error && <Banner tone="warn" role="alert">{error}</Banner>}
        <p className={`${styles.foot} ${styles.footRow}`}><a href="/signup">Create account</a><a href="/forgot-password">Forgot password?</a></p>
      </Card>
    </main>
  );
}

export default function LoginPage() { return <Suspense><LoginForm /></Suspense>; }
