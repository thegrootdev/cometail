import type { Metadata } from "next";
import { product } from "@/content/cometail";
import { Providers } from "@/lib/providers";
import "./globals.css";
import "./theme.css";

export const metadata: Metadata = {
  metadataBase: new URL(product.url),
  title: { default: product.name, template: `%s · ${product.name}` },
  description: product.description,
  alternates: { canonical: "/" },
  icons: {
    icon: [{ url: "/brand/favicon-32.png", sizes: "32x32" }, { url: "/brand/favicon-64.png", sizes: "64x64" }],
    apple: "/brand/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    url: product.url,
    siteName: product.name,
    title: product.tagline,
    description: product.description,
    images: [{ url: "/brand/og.png", width: 1200, height: 630, alt: product.name }],
  },
  twitter: { card: "summary_large_image", site: product.xHandle, creator: product.xHandle, title: product.tagline, description: product.description, images: ["/brand/og.png"] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased"><Providers>{children}</Providers></body>
    </html>
  );
}
