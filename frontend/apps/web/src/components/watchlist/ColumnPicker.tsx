"use client";
import { useState } from "react";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import type { Col } from "./viewTypes";
import styles from "./watchlist.module.css";

// ≡ Column picker: a checklist of the current view's columns. Symbol is fixed and not listed.
export function ColumnPicker({ columns, hidden, onChange }: { columns: Col[]; hidden: string[]; onChange: (hidden: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const off = new Set(hidden);
  const toggle = (id: string) => onChange(columns.map((c) => c.id).filter((cid) => (cid === id ? !off.has(id) : off.has(cid))));
  return (
    <>
      <Button size={36} aria-label="Choose columns" aria-haspopup="dialog" onClick={() => setOpen(true)}>≡ Columns</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Columns" actions={<Button onClick={() => setOpen(false)}>Done</Button>}>
        <p className={styles.sub}>Symbol is always shown.</p>
        <ul className={styles.pickList}>
          {columns.map((c) => (
            <li key={c.id}>
              <label><input type="checkbox" checked={!off.has(c.id)} onChange={() => toggle(c.id)} /> {c.label}</label>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
