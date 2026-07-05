import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Spectral } from "next/font/google";
import "./globals.css";
import { ThemeScript } from "@/components/shell/ThemeScript";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

// next/font binds the real font files to the same CSS variables the tokens use,
// so Inter (UI), Spectral (display headings — the "register" serif) and
// JetBrains Mono (evidence blocks) load without layout shift.
const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
const spectral = Spectral({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "School Management System",
  description: "Multi-tenant LMS, monitoring, and assessment integrity.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} ${spectral.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
        {/* Universal theme control — reachable on every page, signed in or not. */}
        <ThemeToggle className="fixed bottom-4 right-4 z-50 print:hidden" />
      </body>
    </html>
  );
}
