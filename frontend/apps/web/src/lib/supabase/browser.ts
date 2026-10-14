import { createBrowserClient } from "@supabase/ssr";

// NEXT_PUBLIC_* values are inlined at build/dev start, so a missing .env.local means these are undefined in the browser too.
export const authConfigured = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export function createSupabaseBrowser() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
