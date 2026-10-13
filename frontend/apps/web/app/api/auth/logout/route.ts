import { db } from "@/server/db/client";
import { createSupabaseServer } from "@/server/supabase/server";
import { supabaseIdentity } from "@/server/auth/identity";
import { recordAuthEvent } from "@/server/auth/ensureAppUser";

// signOut() revokes the refresh token at Supabase, so a copied cookie stops working server-side too.
export async function POST(req: Request) {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
    const identity = await supabaseIdentity(req);
    if (identity) {
      const row = db().prepare("SELECT user_id FROM users WHERE auth_user_id = ?").get(identity.authUserId) as { user_id: number } | undefined;
      recordAuthEvent(db(), { userId: row?.user_id ?? null, email: identity.email, event: "logout", provider: identity.provider });
    }
    await createSupabaseServer().auth.signOut();
  }
  return Response.json({ ok: true });
}
