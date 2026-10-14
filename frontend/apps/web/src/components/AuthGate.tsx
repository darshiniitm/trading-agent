"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AUTH_ERRORS } from "@/lib/authRedirect";

type Me = { multiUser: boolean; currentUser: { userId: number; displayName: string; email: string | null } | null; denied?: string | null };
const PUBLIC = ["/login", "/signup", "/forgot-password", "/auth/callback"];

// UI only: middleware.ts and requireUser() do the real gating. This just avoids flashing app chrome to a signed-out visitor.
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const pathname = usePathname();
  useEffect(() => { fetch("/api/auth/me").then((res) => res.json()).then(setMe).catch(() => setMe({ multiUser: false, currentUser: null })); }, []);
  if (PUBLIC.includes(pathname ?? "")) return <>{children}</>;
  if (!me) return null;
  if (me.denied) return <main><p role="alert">{AUTH_ERRORS[me.denied] ?? "This account is not allowed."} <a href="/login">Back to sign in</a></p></main>;
  if (!me.currentUser) return <main><p><a href="/login">Sign in</a> to continue.</p></main>;
  return <>{children}</>;
}
