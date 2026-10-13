import { createServerClient, parseCookieHeader } from "@supabase/ssr";

export type AuthIdentity = {
  authUserId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  provider: string;
};

export type IdentityResolver = (req: Request) => Promise<AuthIdentity | null>;

export function identityFromSupabaseUser(user: any): AuthIdentity {
  const meta = user.user_metadata ?? {};
  const provider = String(user.app_metadata?.provider ?? "email");
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : null;
  return {
    authUserId: String(user.id),
    email,
    // Supabase only issues a session for a password account after the confirmation link was clicked,
    // and OAuth emails come back verified; the explicit timestamp is the authoritative signal.
    emailVerified: Boolean(email && (user.email_confirmed_at || user.confirmed_at)),
    displayName: String(meta.display_name ?? meta.full_name ?? meta.name ?? meta.user_name ?? "").trim() || null,
    provider,
  };
}

/** Verified against Supabase (getUser), never the unverified cookie contents. */
export const supabaseIdentity: IdentityResolver = async (req) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const supabase = createServerClient(url, key, {
    cookies: { getAll: () => parseCookieHeader(req.headers.get("cookie") ?? ""), setAll: () => {} },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return identityFromSupabaseUser(data.user);
};
