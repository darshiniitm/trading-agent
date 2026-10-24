# Login & Authentication Plan — Google, GitHub, Email/Password

**Status:** Draft · 12 Oct 2026 · v0.2. Sign-in methods are decided: Google, GitHub, and email + name + password sign-up.
**Scope:** prompt-screener web app (`frontend/apps/web`, Next.js 14) + Supabase warehouse (`db/migrations`)
**Out of scope:** Python engine, weekly jobs, `track_*.py` scripts. These are server-side jobs and keep using the service DB URL with no user login.

---

## 1. Where we are today

| Piece | Current state |
|---|---|
| Login | Email + password. `src/server/auth/users.ts` hashes with argon2id into SQLite `users.password_hash`. |
| Session | Stateless HMAC cookie `prompt_screener_session` = `userId.expiry.sig`, 30 days, `HttpOnly; SameSite=Lax`, no `Secure`. Secret is `SESSION_SECRET`. |
| Current user | `getCurrentUserId()` in `src/server/auth/currentUser.ts`. 11 API routes plus `AppShell` and `AuthGate` call it. |
| Gate | `AuthGate.tsx` is client-side only. It shows "Sign in" only when more than one active user exists. |
| Warehouse | Supabase `app.users(user_id bigint, display_name, legacy_id)` has no email, no auth link, no role or status. |
| Hosting | `next dev -H 127.0.0.1`: local only. |

### Problems to fix before anything is exposed beyond localhost

1. **Single-user fallback signs everyone in.** If exactly one active user exists, any request is treated as that user, whether it has no cookie or a forged one (`return userId === users[0].user_id ? userId : users[0].user_id`). This is fine on 127.0.0.1 but critical on any network.
2. **Non-SQLite fallback.** `if (typeof raw.prepare !== "function") return 1` makes every request user 1 once the DB client changes, for example during the Supabase move.
3. **No revocation.** Logout only clears the browser cookie. A copied cookie stays valid for 30 days and cannot be killed server-side.
4. **The gate is client-side.** Pages render without auth, and 16 API routes never check the user, including all of `drafts/[draftId]/*`, `prompts/[promptId]/retire`, `engine/retry` and `data/prefetch`. Anyone who can reach the server can retire any prompt. Only the React gate hides content.
5. **No `Secure` flag and no login rate limiting.** Both are needed once the app is hosted.

---

## 2. Recommendation in one paragraph

Use **Supabase Auth** as the identity provider, with three sign-in methods (decided 12 Oct 2026):

| Method | How |
|---|---|
| **Continue with Google** | Supabase OAuth provider `google` |
| **Continue with GitHub** | Supabase OAuth provider `github` |
| **Create account with Name, Email, Password** | Supabase `signUp({ email, password, options: { data: { display_name } } })`, plus email confirmation and password reset |

Supabase hashes and stores the passwords (bcrypt in `auth.users`), so our own argon2 `password_hash` column and `SESSION_SECRET` are retired. Supabase Auth runs in the same project as the warehouse, so it costs nothing extra. It handles both OAuth flows, password storage, confirmation and reset emails, refresh tokens, revocation and account linking. It also gives every person a stable `auth.users.id` (uuid), which we map to our **numeric** `app.users.user_id`, so all user-visible ids stay numeric-only. Authorization (who owns which prompt or watchlist) stays in our server code. Postgres RLS comes later as defence in depth.

### Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Supabase Auth (Google + GitHub + email/password)** | Already in the stack. Google, OTP and linking built in. Revocable sessions. Works whether app tables are in SQLite or Postgres. | Ties identity to Supabase. Needs `@supabase/ssr` cookie plumbing in Next.js. | **Recommended** |
| B. Auth.js (NextAuth) + Google | Provider-agnostic. Huge ecosystem. | We would own the session/adapter tables and the email sender. More code, and a second identity store alongside the Supabase one. | Fallback if you want to leave Supabase later |
| C. Keep custom auth, hand-roll Google OIDC | No new dependencies. | We would implement state/PKCE, ID-token validation and key rotation ourselves. That is the highest-risk path. | Not recommended |

---

## 3. Target design

### 3.1 Sign-in flows

All three methods end in the **same `/auth/callback` route** and the same `ensureAppUser()`, so there is one code path for creating and linking app users.

**A. Google / GitHub (OAuth)**

```
Browser ──"Continue with Google" | "Continue with GitHub"──▶ /login (client)
   supabase.auth.signInWithOAuth({ provider: 'google' | 'github',
       options: { redirectTo: `${APP_URL}/auth/callback?next=/prompts` } })
        │
        ▼
Provider consent ─▶ https://<ref>.supabase.co/auth/v1/callback ─▶ APP_URL/auth/callback?code=…
        │
        ▼
/auth/callback (route handler, server)
   1. supabase.auth.exchangeCodeForSession(code)   → sets sb-* cookies (PKCE)
   2. ensureAppUser(authUser)                       → upsert app.users, check allowlist
   3. redirect(next)  (only same-origin relative paths are allowed)
```

- **Google** scopes: `openid email profile`. The display name comes from `user_metadata.full_name`.
- **GitHub** scopes: `read:user user:email`. Supabase reads the user's **primary verified** email even when it is hidden on their profile. If a GitHub account has no verified email, Supabase rejects the sign-in, and `/login` shows "Your GitHub account has no verified email — verify one on GitHub or use another method." The display name is `user_metadata.full_name`, falling back to `user_name`.

**B. Create account (Name, Email, Password)**

```
/signup form: Name, Email, Password, Confirm password
   supabase.auth.signUp({ email, password,
       options: { data: { display_name: name },
                  emailRedirectTo: `${APP_URL}/auth/callback?next=/prompts` } })
        │
        ▼
"Check your inbox" screen ─▶ user clicks the confirmation link ─▶ /auth/callback?code=…
        │                                                          (same steps 1–3 as above)
        ▼
Later visits: /login form: Email + Password → supabase.auth.signInWithPassword()
```

- **Email confirmation is ON.** No session is issued and no `app.users` row is created until the user clicks the link. This stops sign-ups with someone else's email, and it is required for safe account linking (§3.3).
- **Password policy** (Supabase → Auth → Providers → Email): minimum **8** characters, matching today's rule, and require letters + digits. Turn on **leaked-password protection** (HaveIBeenPwned check) if your plan includes it. The client-side zod schema mirrors the same rules so errors show inline.
- **Forgot password:** `/forgot-password` calls `resetPasswordForEmail(email, { redirectTo: APP_URL/auth/callback?next=/reset-password })`. `/reset-password` (signed-in via the recovery link) calls `updateUser({ password })`.
- **Enumeration-safe messages:** signup and forgot-password always reply "If that email can be used, we've sent a link". Login failure always says "Invalid email or password".
- **Rate limits:** use Supabase's built-in limits on sign-up, sign-in and email sends. Add **CAPTCHA** (Turnstile or hCaptcha, a toggle in Supabase) before the app is hosted publicly.

### 3.1a Account linking across methods

The same person may use Google one day and GitHub or a password the next. The rule is **one person = one `app.users` row, keyed by verified email**:

- Supabase **automatically links** a new identity to an existing `auth.users` row when the emails match **and both are verified**. Google emails are verified, GitHub primary emails are verified, and password sign-ups become verified once confirmed. All three therefore resolve to the same `auth_user_id`, and so to the same numeric `user_id`.
- An **unconfirmed** password sign-up never links and never gets a session. This is why confirmation must stay on.
- A **Settings → Sign-in methods** panel (P5) lists linked identities (`auth.getUserIdentities()`). It lets a user connect another provider (`linkIdentity`, which needs manual linking enabled in Supabase) or set a password on an OAuth-only account. Unlinking is blocked if it would leave zero methods.

### 3.2 Session handling

- `@supabase/ssr` with `createServerClient` (route handlers and server components) and `createBrowserClient` (login page only).
- **`middleware.ts`** refreshes the session on every request and redirects unauthenticated page requests to `/login?next=…`. Public paths are `/login`, `/auth/callback`, `/api/health` and static assets.
- Server-side identity always comes from `supabase.auth.getUser()`, which is verified with Supabase. Never trust `getSession()` alone on the server.
- Access token is about 1 hour with a rotating refresh token. **Logout** calls `supabase.auth.signOut()`, which revokes the refresh token server-side and fixes problem 3.
- Cookies get `Secure` automatically when served over https.

### 3.3 Mapping identity to our numeric user

New helper `src/server/auth/requireUser.ts` replaces `getCurrentUserId`:

```ts
export async function requireUser(req): Promise<{ userId: number; role: 'owner'|'member'; email: string }>
// 1. getUser() from the Supabase server client → authUser or throw AuthRequiredError (→ 401)
// 2. look up app.users by auth_user_id → numeric user_id; status must be 'active' (else 403)
```

`ensureAppUser(authUser)` runs in the callback and is idempotent:

1. If an `app.users` row exists for `auth_user_id`, update `last_login_at` and return it.
2. Otherwise, if a row exists with the same **verified** email and a null `auth_user_id`, **link** it. This is how your existing user 1 / Owner account carries over with all its prompts.
3. Otherwise, if the email is allowed to sign up (see 3.5), insert a new row with `role='member'`. `display_name` comes from the sign-up form's Name for password accounts, or from `full_name` / GitHub `user_name` for OAuth accounts. The user can edit it later.
4. Otherwise, sign out and redirect to `/login?error=not_invited`.

### 3.4 Data model: migration `db/migrations/0009_auth.sql`

```sql
create extension if not exists citext;

alter table app.users
  add column auth_user_id uuid unique references auth.users(id) on delete set null,
  add column email        citext unique,
  add column role         text not null default 'member' check (role in ('owner','member')),
  add column status       text not null default 'active' check (status in ('active','disabled')),
  add column last_login_at timestamptz;

create table app.signup_allowlist (
  email      citext primary key,
  invited_by bigint references app.users,
  created_at timestamptz not null default now()
);

create table app.auth_events (            -- append-only audit trail
  event_id   bigint generated always as identity primary key,
  user_id    bigint references app.users,
  email      citext,
  event      text not null check (event in ('login','logout','link','signup','denied','password_reset')),
  provider   text,                        -- 'google' | 'github' | 'email'
  ip         inet,
  user_agent text,
  at         timestamptz not null default now()
);
```

- `user_id` stays `bigint identity`, so the numeric-only id rule is preserved. The uuid never appears in URLs or UI.
- Until the app tables move from SQLite to Supabase, apply the same columns to the SQLite `users` table (new `frontend/.../migrations/00xx_auth.sql`). Supabase Auth works the same whichever store holds `users`.
- After cut-over, drop `password_hash` (SQLite) and remove `argon2` and `SESSION_SECRET`.

### 3.5 Who may sign in

| Mode | Behaviour |
|---|---|
| **Invite-only (recommended for now)** | Only emails in `app.signup_allowlist`, or already linked, can create an account. Owner manages the list from a small `/settings/users` page. This protects Anthropic API spend, since every draft calls the model. |
| Domain-restricted | Allow `*@syntaraa.com` etc. One check in `ensureAppUser`. |
| Open | Anyone with a Google account. Needs per-user rate and spend limits first. |

### 3.6 Authorization

Authentication proves who the user is. Authorization decides what they can do. Every route currently calling `getCurrentUserId`, plus every route that takes an id, follows these rules:

| Resource | Rule |
|---|---|
| Drafts | Owner only (`prompt_drafts.user_id = me`) |
| Prompts: edit, retire, visibility | Owner only (`owner_user_id = me`) |
| Prompts: read, copy, follow | Owner, **or** `visibility = 'public'` |
| Watchlists and entries | Owner of the underlying prompt, or prompt is public (read-only) |
| `/api/data/prefetch`, `/api/engine/retry`, `/data-health` | `role = 'owner'` |
| `/api/quotes`, `/api/series/closes` | Any signed-in user, with rate limits |
| `/api/health` | Public |

Return **404, not 403**, for another user's private resource, so ids can't be probed.

**RLS:** the Next.js server connects with the service connection string, which bypasses RLS. Enforcement therefore lives in `requireUser` plus ownership-checked queries. Add RLS policies only if the browser ever queries Supabase directly. That is tracked as a later phase, not needed for launch.

---

## 4. Provider setup (manual steps for Dharmin)

1. **Google Cloud Console**: create or choose a project, for example "Prompt Screener".
   - *OAuth consent screen*: External, app name, support email, scopes `openid`, `email`, `profile` only. These are non-sensitive, so no Google security review is needed. Keep it in **Testing** and add test users, or publish once hosted.
   - *Credentials → Create OAuth client ID → Web application*
     - Authorized JavaScript origins: `http://localhost:3000` (plus the production URL later)
     - Authorized redirect URI: `https://eelonzthtzdtpttkyeff.supabase.co/auth/v1/callback`
2. **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.** Use an organisation-owned app if the app should outlive your personal account.
   - Application name: "Prompt Screener". Homepage URL: `http://localhost:3000`.
   - Authorization callback URL: `https://eelonzthtzdtpttkyeff.supabase.co/auth/v1/callback`. A GitHub OAuth App allows **one** callback URL, and because it points at Supabase it works for local and production alike.
   - Generate a client secret and copy the Client ID and Secret.
   - Use an **OAuth App**, not a GitHub App. Supabase's GitHub provider expects OAuth App credentials.
3. **Supabase dashboard → Authentication**
   - *Providers → Google*: paste the Client ID and Secret, then enable it.
   - *Providers → GitHub*: paste the Client ID and Secret, then enable it.
   - *Providers → Email*: enable **Email/Password**, turn **Confirm email ON**, and set minimum password length 8 with letters + digits. Turn on leaked-password protection if your plan offers it. Magic link is optional and off by default for now.
   - *Sign-in / Providers → Auth settings*: keep **automatic linking of same verified email** (default). Enable **manual linking** for the P5 "connect another provider" panel.
   - *URL Configuration*: Site URL `http://localhost:3000`; Redirect URLs `http://localhost:3000/auth/callback` (add prod later).
   - *Email templates*: brand the **Confirm signup** and **Reset password** emails, with links pointing to `{{ .SiteURL }}/auth/callback?...`.
   - **Custom SMTP** (for example Resend, SES or Postmark): needed before real users sign up. Password sign-up depends on confirmation emails, and Supabase's built-in sender only allows a handful of emails per hour.
4. **`.env.local`** (web app). Never commit it.
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://eelonzthtzdtpttkyeff.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=…        # safe for browser
   SUPABASE_SERVICE_ROLE_KEY=…            # server only, used by admin/invite page
   APP_URL=http://localhost:3000
   ```

> Use **`localhost`** consistently, not `127.0.0.1`. Cookies and Google origins treat them as different sites. Change the dev script to `next dev -H localhost`.

---

## 5. Implementation phases

| Phase | Work | Done when |
|---|---|---|
| **P0 – Close holes (now, about ½ day)** | Remove the single-user and `return 1` fallbacks from `getCurrentUserId`. Enforce auth server-side in **every** API route (401 JSON). Only 11 call `getCurrentUserId` today; `drafts/[draftId]/*`, `quotes`, `series`, `engine/*` and `data/*` check nothing. Add `Secure` when `APP_URL` is https. | Test: with one active user, a request with no cookie or a forged cookie gets **401**. |
| **P1 – Provider setup** | §4 steps 1–4 (manual): Google client, GitHub OAuth App, Supabase providers, SMTP, env vars. Add `@supabase/ssr` and `@supabase/supabase-js`. | Google and GitHub sign-ins both reach `/auth/callback` with a code. A test sign-up receives a confirmation email. |
| **P2 – Schema** | `0009_auth.sql` (Postgres) plus the mirror SQLite migration. Seed the allowlist with your email. Set user 1's `email` and `role='owner'`. | `python -m db.migrate` passes; `tests/test_db_migrations.py` is extended. |
| **P3 – Next.js integration** | `src/server/supabase/{server,browser}.ts`, `middleware.ts`, `app/auth/callback/route.ts`, `requireUser.ts`, `ensureAppUser.ts`. Pages (restyled per the UI plan's 400 px auth card):<br>• `/login`: **Continue with Google**, **Continue with GitHub**, a divider, then Email + Password, plus "Forgot password?" and "Create account" links.<br>• `/signup`: Name, Email, Password, Confirm password, the two OAuth buttons, then a "Check your inbox" state with a resend button.<br>• `/forgot-password` and `/reset-password`.<br>`/api/auth/me` reads from `requireUser`. Logout calls `signOut()`. The old `/api/auth/{login,signup}` routes are deleted, because the forms call Supabase directly. | All three methods sign in. Signing in with Google, GitHub or password using your email shows the **same** existing prompts. |
| **P4 – Authorization pass** | Apply the §3.6 rules route by route. `AuthGate` becomes a thin UI layer; middleware does the real gating. | Tests for owner, other user, public and anonymous cases on every route. |
| **P5 – Cut-over and cleanup** | Remove argon2, `password_hash`, `session.ts` and `SESSION_SECRET`. Write `auth_events` on login, logout, denied and password reset. Add a `/settings/users` allowlist page (owner only). Add **Settings → Sign-in methods** (list, connect and disconnect identities, set or change password, edit display name). | No custom session code left; audit rows appear; a Google-only user can add GitHub and a password. |
| **P6 – Hosting readiness (when needed)** | Production URL in Google origins and Supabase redirect list. Publish the consent screen. Turn on CAPTCHA for sign-up, sign-in and reset. Rate-limit `/api/quotes` and model-calling routes per user. Optional RLS policies. Optional MFA through Supabase. | Checklist signed off before the first non-localhost deploy. |

## 6. Tests

- **Unit (vitest):** `requireUser` with a mocked `getUser` covering no user, unknown user, disabled user and valid user. `ensureAppUser` covering existing, link-by-verified-email, allowlisted, denied, and unverified email that must **not** link.
- **Route tests:** for every API route, anonymous gets 401, another user's private resource gets 404, owner gets 200, and a public prompt is read-only for others.
- **Sign-up form:** zod validation covers empty name, bad email, a password under 8 characters or without digits, and a confirm-password mismatch. An already-registered email still shows the neutral "check your inbox" message.
- **Linking:** a password sign-up and a later Google login with the same email resolve to the same `user_id`. An **unconfirmed** password account never yields a session or an `app.users` row.
- **GitHub:** a mocked identity with no verified email shows the friendly error and creates no row.
- **Callback:** `next` param open-redirect guard. Reject absolute URLs and `//evil.com`.
- **E2E (Playwright):** the email/password path is fully automatable. Create a pre-confirmed test user through the Supabase admin API (`auth.admin.createUser({ email_confirm: true })`), then drive sign-in, sign-out, reset (using `generateLink` for the recovery link) and the middleware redirects. Google and GitHub consent screens can't be automated; test those manually from the P1 checklist.

## 7. Decisions needed from you

✅ **Decided 12 Oct 2026:** sign-in methods are Google, GitHub, and Create account with Email, Name, Password.

1. **Provider:** Supabase Auth (recommended) or Auth.js?
2. **Email sender (SMTP):** which service sends confirmation and reset emails? Resend is the simplest; SES is the cheapest at volume. A sending domain (for example `mail.syntaraa.com`) is needed either way.
3. **Who can join:** invite-only allowlist (recommended), domain-restricted (which domains?), or open?
4. **Hosting timeline:** stay on localhost for now, or deploy soon? This decides when P6 is needed and which production URL to register with Google.
5. **Session length:** Supabase default (refresh token valid until sign-out or inactivity) or a hard cap, for example 30 days?
