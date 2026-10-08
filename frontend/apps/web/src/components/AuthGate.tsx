"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

type Me = { multiUser: boolean; currentUser: { userId: number; displayName: string; email: string | null } | null };

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const pathname = usePathname();
  useEffect(() => { fetch("/api/auth/me").then((res) => res.json()).then(setMe).catch(() => setMe({ multiUser: false, currentUser: null })); }, []);
  if (!me) return null;
  if (me.multiUser && !me.currentUser && pathname !== "/login" && pathname !== "/signup") return <main><p><a href="/login">Sign in</a> to continue.</p></main>;
  return <>{children}</>;
}
