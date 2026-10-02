"use client";
import { useEffect } from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { walletAccessibility as copy } from "@/content/cometail";

/** Add focus and accessible names to the library's portal without changing wallet selection. */
export function WalletModalAccessibility() {
  const { visible } = useWalletModal();
  useEffect(() => {
    if (!visible) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let dialog: HTMLElement | null = null;
    let frames: { element: HTMLElement; inert: boolean }[] = [];
    const focusable = () => dialog ? [...dialog.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")]
      .filter(el => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0) : [];
    const prepare = () => {
      const node = document.querySelector<HTMLElement>(".wallet-adapter-modal");
      if (!node) return;
      dialog = node;
      const title = node.querySelector<HTMLElement>(".wallet-adapter-modal-title");
      if (title) title.id = "wallet-adapter-modal-title";
      node.querySelector(".wallet-adapter-modal-button-close")?.setAttribute("aria-label", copy.close);
      frames = [...document.querySelectorAll<HTMLElement>(".site-frame")].map(element => ({ element, inert: element.inert }));
      frames.forEach(({ element }) => { element.inert = true; });
      node.tabIndex = -1;
      (focusable()[0] ?? node).focus();
      observer.disconnect();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const nodes = focusable();
      const index = nodes.indexOf(document.activeElement as HTMLElement);
      if (!nodes.length || index < 0 || (event.shiftKey ? index === 0 : index === nodes.length - 1)) {
        event.preventDefault();
        event.stopPropagation();
        (event.shiftKey ? nodes[nodes.length - 1] ?? dialog : nodes[0] ?? dialog).focus();
      }
    };
    const observer = new MutationObserver(prepare);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", keydown, true);
    prepare();
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", keydown, true);
      frames.forEach(({ element, inert }) => { element.inert = inert; });
      if (opener?.isConnected) opener.focus();
    };
  }, [visible]);
  return null;
}
