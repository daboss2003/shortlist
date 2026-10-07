import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Native/Node-only libraries used by the CV pipeline and exports must not be bundled.
  serverExternalPackages: ["better-sqlite3", "unpdf", "mammoth", "exceljs", "jszip"],
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
