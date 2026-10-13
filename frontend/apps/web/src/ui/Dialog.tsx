"use client";
import { useEffect, useRef } from "react";
import styles from "./Dialog.module.css";

// Native <dialog>: focus is trapped by the browser and returned to the opener on close.
export function Dialog({ open, onClose, title, children, actions }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) { if (typeof el.showModal === "function") el.showModal(); else el.setAttribute("open", ""); }
    if (!open && el.open) { if (typeof el.close === "function") el.close(); else el.removeAttribute("open"); }
  }, [open]);
  return (
    <dialog ref={ref} className={styles.dlg} aria-label={title} onClose={onClose}>
      {open && (<><h2>{title}</h2>{children}<div className={styles.actions}>{actions}</div></>)}
    </dialog>
  );
}
