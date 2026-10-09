import type { MetadataRoute } from "next";
import { product } from "@/content/cometail";

export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/", disallow: "/admin" }], sitemap: `${product.url}/sitemap.xml` };
}
