import type { Metadata } from "next";
import { pageTitles as t } from "@/content/cometail";

export const metadata: Metadata = { title: t.launch };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
