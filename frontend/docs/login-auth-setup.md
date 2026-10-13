# Login setup (Supabase Auth: Google, GitHub, email + password)

Code is implemented per the login/authentication plan (v0.2). The manual provider steps (plan §4) are still yours:

1. Google Cloud OAuth client + GitHub **OAuth App**, both with callback `https://eelonzthtzdtpttkyeff.supabase.co/auth/v1/callback`.
2. Supabase → Authentication: enable Google, GitHub, Email (Confirm email ON, min length 8); Site URL `http://localhost:3000`,
   redirect `http://localhost:3000/auth/callback`; enable manual linking; custom SMTP before real users sign up.
3. Copy `apps/web/.env.local.example` to `.env.local` and fill in the anon key and `OWNER_EMAIL` (the email you sign in with, so your existing
   user 1 and its prompts carry over). Use `localhost`, not `127.0.0.1` (the dev script now binds `localhost`).
4. Invite others: insert into the `signup_allowlist` table (owner-only UI page is not built yet).

Without the env vars every request is 401 and `/login` shows "Sign-in isn't configured".

## Where things are
- `src/server/auth/requireUser.ts` — the only way a route learns the caller (`withUser`, `requireOwner`); no fallbacks.
- `src/server/auth/ensureAppUser.ts` — identity → numeric user (link by verified email, allowlist, audit events).
- `src/server/auth/ownership.ts` — draft / prompt / watchlist checks (other users' private resources are 404).
- `middleware.ts` — session refresh + redirect/401 gating. `app/auth/callback/route.ts` — code exchange.
- Migration `src/server/db/migrations/0011_auth.sql` (SQLite) mirrors Postgres `db/migrations/0009_auth.sql` in the main repo.

## Not built yet (plan P5/P6)
Settings → Sign-in methods (link/unlink identities), `/settings/users` allowlist page, CAPTCHA, per-user rate limits on `/api/quotes` and model-calling routes, RLS.
