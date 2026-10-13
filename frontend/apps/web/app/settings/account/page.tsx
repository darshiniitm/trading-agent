"use client";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/ui/Card";
import { FieldText } from "@/ui/Fields";
import { Button } from "@/ui/Button";
import { Banner } from "@/ui/Banner";
import { AUTH_ERRORS } from "@/lib/authRedirect";
import { authConfigured, createSupabaseBrowser } from "@/lib/supabase/browser";
import { resetSchema, firstError } from "@/lib/authSchemas";
import styles from "../../auth.module.css";

type Identity = { identity_id: string; provider: string };
const PROVIDERS = [{ id: "google", label: "Google" }, { id: "github", label: "GitHub" }] as const;

export default function AccountSettingsPage() {
  const qc = useQueryClient();
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ tone: "info" | "warn"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!authConfigured) { setMsg({ tone: "warn", text: AUTH_ERRORS.not_configured }); return; }
    const { data } = await createSupabaseBrowser().auth.getUserIdentities();
    setIdentities((data?.identities ?? []) as Identity[]);
  }, []);
  useEffect(() => {
    void load();
    fetch("/api/auth/me").then((r) => r.json()).then((m) => setName(m.currentUser?.displayName ?? ""));
  }, [load]);

  const has = (p: string) => identities.some((i) => i.provider === p);
  async function connect(provider: "google" | "github") {
    if (!authConfigured) return;
    const { error } = await createSupabaseBrowser().auth.linkIdentity({ provider, options: { redirectTo: `${window.location.origin}/auth/callback?next=/settings/account` } });
    if (error) setMsg({ tone: "warn", text: "Couldn't start linking. Is manual linking enabled in Supabase?" });
  }
  async function disconnect(provider: string) {
    if (!authConfigured) return;
    const target = identities.find((i) => i.provider === provider);
    if (!target) return;
    if (identities.length <= 1) { setMsg({ tone: "warn", text: "You can't remove your only sign-in method." }); return; }
    const { error } = await createSupabaseBrowser().auth.unlinkIdentity(target as any);
    setMsg(error ? { tone: "warn", text: "Couldn't disconnect that method." } : { tone: "info", text: `${provider} disconnected.` });
    await load();
  }
  async function savePassword() {
    if (!authConfigured) return;
    const parsed = resetSchema.safeParse({ password, confirm });
    if (!parsed.success) { setMsg({ tone: "warn", text: firstError(parsed) }); return; }
    const { error } = await createSupabaseBrowser().auth.updateUser({ password: parsed.data.password });
    setMsg(error ? { tone: "warn", text: "Couldn't set the password." } : { tone: "info", text: "Password saved." });
    if (!error) { setPassword(""); setConfirm(""); await load(); }
  }
  async function saveName() {
    const res = await fetch("/api/auth/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: name }) });
    setMsg(res.ok ? { tone: "info", text: "Name saved." } : { tone: "warn", text: "Enter a name (1-80 characters)." });
    if (res.ok) void qc.invalidateQueries({ queryKey: ["me"] });
  }

  return (
    <main className={styles.wrap} style={{ maxWidth: 520 }}>
      {msg && <Banner tone={msg.tone} role="status">{msg.text}</Banner>}
      <Card title="Display name">
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
          <FieldText label="Name" aria-label="display name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button variant="primary" type="submit">Save name</Button>
        </form>
      </Card>
      <Card title="Sign-in methods">
        <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {PROVIDERS.map((p) => (
            <li key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{p.label}</span>
              {has(p.id) ? <Button size={36} onClick={() => void disconnect(p.id)}>Disconnect</Button> : <Button size={36} onClick={() => void connect(p.id)}>Connect</Button>}
            </li>
          ))}
          <li><span>Email &amp; password: {has("email") ? "set" : "not set"}</span></li>
        </ul>
      </Card>
      <Card title={has("email") ? "Change password" : "Set a password"}>
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void savePassword(); }}>
          <FieldText label="New password" aria-label="new password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <FieldText label="Confirm password" aria-label="confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button variant="primary" type="submit">{has("email") ? "Change password" : "Set password"}</Button>
        </form>
      </Card>
    </main>
  );
}
