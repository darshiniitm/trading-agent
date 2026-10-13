"use client";
import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { EnginePill } from "@/components/EngineStatus";
import styles from "./AppShell.module.css";

type Me = { multiUser: boolean; currentUser: { userId: number; displayName: string; email: string | null; role?: string } | null };
const AUTH_PAGES = ["/login", "/signup", "/forgot-password"];
export type NavKey = "prompts" | "new" | "explore" | "data";

export function activeNav(pathname: string | null): NavKey | null {
  if (!pathname) return null;
  if (pathname.startsWith("/drafts")) return "new";
  if (pathname.startsWith("/explore")) return "explore";
  if (pathname.startsWith("/data-health")) return "data";
  if (pathname.startsWith("/prompts") || pathname.startsWith("/watchlists")) return "prompts";
  return null;
}

const NAV: { key: NavKey; href: string; label: string; quiet?: boolean }[] = [
  { key: "prompts", href: "/prompts", label: "My prompts" },
  { key: "new", href: "/drafts/new", label: "New prompt" },
  { key: "explore", href: "/explore", label: "Explore" },
  { key: "data", href: "/data-health", label: "Data health", quiet: true },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const active = activeNav(pathname);
  const { data: me } = useQuery<Me>({ queryKey: ["me"], queryFn: () => fetch("/api/auth/me").then((r) => r.json()) });
  const user = me?.currentUser ?? null;
  if (AUTH_PAGES.includes(pathname ?? "")) return <>{children}</>;   // signed-out visitors get no app chrome

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <>
      <header className={styles.header}>
        <a href="/prompts" className={styles.logo} aria-label="Prompt Screener home">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>
          Prompt Screener
        </a>
        <nav className={styles.nav} aria-label="Main">
          {NAV.map((n) => (
            <a key={n.key} href={n.href} aria-current={active === n.key ? "page" : undefined} className={`${styles.item} ${n.quiet ? styles.quiet : ""} ${active === n.key ? styles.active : ""}`}>{n.label}</a>
          ))}
        </nav>
        <EnginePill />
        {user && (
          <div className={styles.user}>
            <span className={styles.avatar} aria-hidden="true">{user.userId}</span>
            <span>{user.displayName} (you)</span>
            <a href="/settings/account" className={styles.signout}>Account</a>
            {user.role === "owner" && <a href="/settings/users" className={styles.signout}>Users</a>}
            <button type="button" className={styles.signout} onClick={() => void signOut()}>Sign out</button>
          </div>
        )}
      </header>
      {children}
    </>
  );
}
