import type { Metadata } from "next";
import { pageTitles as t } from "@/content/cometail";

export const metadata: Metadata = { title: t.fees, description: t.feesDescription };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
