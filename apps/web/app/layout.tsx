import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeScript } from "@/components/shell/ThemeScript";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";

// SELF-HOSTED fonts (woff2 in ./fonts, downloaded from Google Fonts, latin subset)
// bound to the same CSS variables the tokens use — Inter (UI), Spectral (display
// "register" serif) and JetBrains Mono (evidence blocks). Self-hosting removes the
// build-time dependency on fonts.gstatic.com (deterministic/air-gapped-safe Docker
// builds) and keeps user font requests off Google's CDN (NDPR-friendly).
const inter = localFont({
  src: [{ path: "./fonts/Inter-latin.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-sans",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});
const mono = localFont({
  src: [{ path: "./fonts/JetBrainsMono-latin.woff2", weight: "100 800", style: "normal" }],
  variable: "--font-mono",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});
const spectral = localFont({
  src: [
    { path: "./fonts/Spectral-500-latin.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Spectral-600-latin.woff2", weight: "600", style: "normal" },
    { path: "./fonts/Spectral-700-latin.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-display",
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

export const metadata: Metadata = {
  title: "School Management System",
  description: "Multi-tenant LMS, monitoring, and assessment integrity.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "SMS" },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0f172a" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} ${spectral.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ServiceWorkerRegister />
        {children}
        {/* Universal theme control — reachable on every page, signed in or not. */}
        <ThemeToggle className="fixed bottom-4 right-4 z-50 print:hidden" />
      </body>
    </html>
  );
}
