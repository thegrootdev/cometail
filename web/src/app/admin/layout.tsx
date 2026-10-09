import type { Metadata } from "next";
import { pageTitles as t } from "@/content/cometail";

// the operator's pages: kept out of search results
export const metadata: Metadata = { title: t.admin, robots: { index: false, follow: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
