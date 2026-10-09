import type { MetadataRoute } from "next";
import { product } from "@/content/cometail";

// the public pages; coin and vault pages are reached from them
export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/launch", "/sell", "/fees", "/stats", "/tails", "/sky", "/presets"].map((p) => ({ url: `${product.url}${p}` }));
}
