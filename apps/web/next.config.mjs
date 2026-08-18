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

  /**
   * Baseline security headers for every response this tier serves.
   *
   * Deliberately NOT a script-src. A full policy needs a per-request nonce for
   * the inline bootstrap Next injects, which means running middleware on every
   * route — and this app's middleware is the thing that redirects unauthenticated
   * users, so widening its matcher risks either holding public pages hostage or
   * opening a protected one. That is its own change, with its own verification.
   *
   * What is here needs no nonce and cannot break a page: no <object>/<embed> is
   * used, nothing sets a <base>, forms are server actions posting to this same
   * origin, and nothing legitimately frames the app. The live-classroom iframe
   * is the app framing SOMEBODY ELSE, which frame-ancestors does not govern.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
