"use client";
import { Segmented } from "@/ui/Segmented";
import { VIEW_LABELS, VIEW_ORDER } from "./columns";
import type { ViewId } from "./viewTypes";

// Screen · Price · Financials · Performance · Risk · Technicals. ← / → move between views (wrapping stays put at the ends).
export function ViewSwitcher({ value, onChange }: { value: ViewId; onChange: (v: ViewId) => void }) {
  function onKeyDown(ev: React.KeyboardEvent) {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    const i = VIEW_ORDER.indexOf(value);
    const next = VIEW_ORDER[Math.min(VIEW_ORDER.length - 1, Math.max(0, i + (ev.key === "ArrowRight" ? 1 : -1)))];
    if (next === value) return;
    ev.preventDefault();
    const box = ev.currentTarget as HTMLElement;   // React nulls currentTarget once the handler returns
    onChange(next);
    requestAnimationFrame(() => box.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus());
  }
  return (
    <div onKeyDown={onKeyDown} style={{ maxWidth: "100%", overflowX: "auto" }} data-testid="view-switcher">
      <Segmented label="Watchlist view" items={VIEW_ORDER.map((id) => ({ id, label: VIEW_LABELS[id] }))} value={value} onChange={onChange} />
    </div>
  );
}
