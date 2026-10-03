"use client";
import { useEffect, useRef, useState } from "react";
import { addresses as copy } from "@/content/cometail";
import { short } from "@/lib/format";

/** The fallback keeps the prior focus/selection and copies the full address. */
export function legacyCopy(value: string): boolean {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const field = document.createElement("textarea");
  field.value = value; field.readOnly = true;
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px";
  document.body.appendChild(field);
  try { field.focus({ preventScroll: true }); field.select(); field.setSelectionRange(0, value.length); return document.execCommand("copy"); }
  finally {
    field.remove(); focused?.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); }
  }
}
export function CopyAddress({ address, label = copy.mint }: { address: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copyAddress = async () => {
    if (busy) return;
    setBusy(true); clearTimeout(timer.current);
    try {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(address);
      } catch { if (!legacyCopy(address)) throw new Error("Copy failed"); }
      setState("copied"); timer.current = setTimeout(() => setState("idle"), 3000);
    } catch { setState("failed"); }
    finally { setBusy(false); }
  };
  return <span className="address-sticker">
    <span className="address-label">{label}</span>
    <button type="button" className="address-copy" onClick={copyAddress} aria-disabled={busy}
      aria-label={`${copy.copy} ${label}: ${address}`} title={address}>
      <span className="address-short">{short(address)}</span>
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="6" y="6" width="11" height="11" rx="2" /><path d="M13 6V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></svg>
    </button>
    <span className="address-feedback" role="status" aria-live="polite">{state === "copied" ? copy.copied : state === "failed" ? copy.failed : ""}</span>
    {state === "failed" && <input className="address-manual" aria-label={`${copy.manual} ${label}`} value={address} readOnly onFocus={e => e.target.select()} />}
  </span>;
}
