export class AuthRequiredError extends Error {}
/** Signed in with Supabase but not allowed in: not on the allowlist, or the account is disabled. */
export class AccountDeniedError extends Error {
  constructor(readonly reason: "not_invited" | "disabled" | "email_conflict", message?: string) { super(message ?? reason); }
}
export class OwnerOnlyError extends Error {}
