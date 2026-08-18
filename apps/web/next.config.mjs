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
   * The floor, for responses the page policy does not reach.
   *
   * `middleware.ts` sets the real policy — including a per-request nonce and a
   * `script-src` — on every PAGE. It deliberately does not run on /api or on
   * static output, so these headers stay as the floor beneath it: the two API
   * proxies add their own far stricter sandbox on top, and anything else served
   * from this tier still gets the directives that need no nonce.
   *
   * Pages therefore carry both policies. That is safe and intended — multiple
   * CSP headers are enforced as an intersection, so the stricter one wins.
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
