import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Route-handler / server-component client; writes refreshed cookies when the runtime allows it. */
export function createSupabaseServer() {
  const store = cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => { try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* read-only render context */ } },
    },
  });
}
