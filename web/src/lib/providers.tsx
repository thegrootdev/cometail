"use client";
// Wallet and connection context for every page. Standard-wallet detection only: no
// hardware-wallet bundle, no adapter list to maintain.
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { useMemo } from "react";
import { SolUsdProvider } from "./prices";
import { RPC_URL } from "./addresses";
import { WalletModalAccessibility } from "@/components/WalletModalAccessibility";
import "@solana/wallet-adapter-react-ui/styles.css";

export function Providers({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider
      endpoint={RPC_URL}
      config={{
        commitment: "confirmed",
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }),
      }}
    >
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider><SolUsdProvider>{children}</SolUsdProvider><WalletModalAccessibility /></WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
