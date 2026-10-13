import { NextResponse } from "next/server";
import { db } from "@/server/db/client";
import { createSupabaseServer } from "@/server/supabase/server";
import { identityFromSupabaseUser } from "@/server/auth/identity";
import { ensureAppUser } from "@/server/auth/ensureAppUser";
import { AccountDeniedError } from "@/server/auth/errors";
import { safeNext } from "@/lib/authRedirect";

export const dynamic = "force-dynamic";

// OAuth, email confirmation and password-recovery links all land here (plan §3.1): exchange the code,
// map the identity to a numeric app user, then redirect to a same-origin path.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = process.env.APP_URL ?? url.origin;
  const to = (path: string) => NextResponse.redirect(new URL(path, origin));
  const next = safeNext(url.searchParams.get("next"));

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return to("/login?error=not_configured");
  const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) return to(`/login?error=${/email/i.test(providerError) ? "github_no_email" : "callback"}`);
  const code = url.searchParams.get("code");
  if (!code) return to("/login?error=callback");

  const supabase = createSupabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return to("/login?error=callback");
  const { data } = await supabase.auth.getUser();
  if (!data.user) return to("/login?error=callback");

  try {
    ensureAppUser(db(), identityFromSupabaseUser(data.user), { ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent") });
  } catch (e) {
    if (e instanceof AccountDeniedError) { await supabase.auth.signOut(); return to(`/login?error=${e.reason}`); }
    throw e;
  }
  return to(next);
}
