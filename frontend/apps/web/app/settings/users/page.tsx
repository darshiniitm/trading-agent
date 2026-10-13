"use client";
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/ui/Card";
import { FieldText } from "@/ui/Fields";
import { Button } from "@/ui/Button";
import { Banner } from "@/ui/Banner";
import styles from "../../auth.module.css";

type Data = { allowlist: { email: string; userId: number | null }[]; users: { userId: number; displayName: string; email: string | null; role: string; status: string; lastLoginAt: string | null }[] };

export default function UsersSettingsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [email, setEmail] = useState(""); const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch("/api/admin/allowlist");
    if (res.status === 403) { setError("Only the owner can manage users."); return; }
    if (res.ok) setData(await res.json());
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function call(method: string, body: object) {
    setError(null);
    const res = await fetch("/api/admin/allowlist", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "Request failed");
    await load();
  }
  return (
    <main className={styles.wrap} style={{ maxWidth: 720 }}>
      {error && <Banner tone="warn" role="alert">{error}</Banner>}
      <Card title="Invite someone">
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void call("POST", { email }).then(() => setEmail("")); }}>
          <FieldText label="Email" aria-label="invite email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button variant="primary" type="submit">Add to allowlist</Button>
        </form>
      </Card>
      {data && (
        <>
          <Card title="Allowlist">
            <ul style={{ listStyle: "none", padding: 0 }}>
              {data.allowlist.map((a) => (
                <li key={a.email} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                  <span>{a.email} {a.userId ? "(joined)" : "(pending)"}</span>
                  <Button size={36} onClick={() => void call("DELETE", { email: a.email })}>Remove</Button>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Users">
            <table><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th /></tr></thead>
              <tbody>{data.users.map((u) => (
                <tr key={u.userId}><td>{u.userId}</td><td>{u.displayName}</td><td>{u.email ?? "—"}</td><td>{u.role}</td><td>{u.lastLoginAt?.slice(0, 10) ?? "never"}</td>
                  <td>{u.role !== "owner" && <Button size={36} onClick={() => void call("PATCH", { userId: u.userId, status: u.status === "active" ? "disabled" : "active" })}>{u.status === "active" ? "Disable" : "Enable"}</Button>}</td></tr>
              ))}</tbody></table>
          </Card>
        </>
      )}
    </main>
  );
}
