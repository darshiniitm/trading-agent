"use client";
import { Button } from "@/ui/Button";
import { authConfigured, createSupabaseBrowser } from "@/lib/supabase/browser";
import { safeNext, AUTH_ERRORS } from "@/lib/authRedirect";
import styles from "../../app/auth.module.css";

export function OAuthButtons({ next, onError }: { next?: string | null; onError: (message: string) => void }) {
  async function go(provider: "google" | "github") {
    if (!authConfigured) { onError(AUTH_ERRORS.not_configured); return; }
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext(next))}`;
    const { error } = await createSupabaseBrowser().auth.signInWithOAuth({
      provider,
      options: { redirectTo, ...(provider === "github" ? { scopes: "read:user user:email" } : {}) },
    });
    if (error) onError("Couldn't start sign-in. Please try again.");
  }
  return (
    <div className={styles.oauth}>
      <Button size={44} onClick={() => void go("google")}>Continue with Google</Button>
      <Button size={44} onClick={() => void go("github")}>Continue with GitHub</Button>
    </div>
  );
}
