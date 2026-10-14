/** Only same-origin relative paths survive; absolute URLs, `//evil.com` and `/\evil.com` fall back. */
export function safeNext(next: string | null | undefined, fallback = "/prompts"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}

export const AUTH_ERRORS: Record<string, string> = {
  not_invited: "This account hasn't been invited yet. Ask the owner to add your email.",
  disabled: "This account has been disabled.",
  email_conflict: "That email is already linked to a different sign-in. Use the method you signed up with.",
  github_no_email: "Your GitHub account has no verified email — verify one on GitHub or use another method.",
  callback: "Sign-in didn't complete. Please try again.",
  not_configured: "Sign-in isn't configured on this server yet (missing Supabase environment variables).",
};
