"use client";
import { Segmented } from "@/ui/Segmented";
import type { Tf } from "./viewTypes";

// Only rendered on the Technicals view. 1W reads the weekly strategy on its own timeframe.
export function TechTimeframeToggle({ value, onChange }: { value: Tf; onChange: (tf: Tf) => void }) {
  return <Segmented label="Technicals timeframe" items={[{ id: "1D" as Tf, label: "1D" }, { id: "1W" as Tf, label: "1W" }]} value={value} onChange={onChange} />;
}
