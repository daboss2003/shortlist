import type { NextConfig } from "next";

const securityHeaders = [
  // Nothing on this site should be framed (clickjacking). frame-ancestors only: a full CSP would need nonces for
  // Next's inline scripts.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // HTTPS-only for two years; not in development, where a browser would then refuse plain http://localhost.
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Native/Node-only libraries used by the CV pipeline and exports must not be bundled.
  serverExternalPackages: ["@electric-sql/pglite", "unpdf", "mammoth", "exceljs", "jszip", "word-extractor"],
  // CV_EXTRACTION=isolated spawns this script as a child process, so it isn't import-traced; ship it explicitly
  // (Netlify's Next.js runtime bundles from Next's file traces, not netlify.toml included_files).
  outputFileTracingIncludes: {
    "/**": ["./scripts/extract-cv-text.mjs", "./src/lib/cv/extract-core.mjs"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
