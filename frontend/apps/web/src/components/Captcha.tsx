"use client";
import { useEffect, useRef } from "react";

// Cloudflare Turnstile. Renders nothing unless NEXT_PUBLIC_CAPTCHA_SITE_KEY is set, so local dev needs no widget.
// Turn the matching CAPTCHA protection on in Supabase → Authentication → Attack Protection (provider: Turnstile).
export const CAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_CAPTCHA_SITE_KEY;

declare global { interface Window { turnstile?: { render: (el: HTMLElement, o: object) => string; reset: (id?: string) => void } } }

export function Captcha({ onToken }: { onToken: (token: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!CAPTCHA_SITE_KEY || !ref.current) return;
    const mount = () => window.turnstile?.render(ref.current!, { sitekey: CAPTCHA_SITE_KEY, callback: (t: string) => onToken(t), "expired-callback": () => onToken(null), "error-callback": () => onToken(null) });
    if (window.turnstile) { mount(); return; }
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true; s.onload = mount;
    document.head.appendChild(s);
  }, [onToken]);
  return CAPTCHA_SITE_KEY ? <div ref={ref} /> : null;
}

/** Spread into Supabase auth options: `{}` when CAPTCHA is off, otherwise the token (or a blocker). */
export function captchaOptions(token: string | null): { captchaToken?: string } {
  return CAPTCHA_SITE_KEY && token ? { captchaToken: token } : {};
}
export const captchaBlocked = (token: string | null) => !!CAPTCHA_SITE_KEY && !token;
