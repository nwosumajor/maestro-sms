import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Minimal, self-contained runtime for the container (copies only traced deps).
  output: "standalone",
  // Monorepo: trace workspace deps from the repo root so they're bundled.
  // (Next 14.2 moved this key under `experimental`.)
  experimental: {
    outputFileTracingRoot: path.join(__dirname, "../../"),
  },
  // Internal workspace packages ship raw TS; Next compiles them.
  transpilePackages: ["@sms/types", "@sms/tokens"],
};

export default nextConfig;
