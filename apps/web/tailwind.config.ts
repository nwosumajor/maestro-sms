import type { Config } from "tailwindcss";

/**
 * Tailwind maps the semantic CSS variables from globals.css to utilities, so the
 * whole app themes by variable swap (per-tenant) with zero component changes.
 * Colors use `hsl(var(--x) / <alpha-value>)` so opacity modifiers still work
 * (e.g. border-border/40).
 */
const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1280px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
        },
        // Integrity severity — constant across tenants (priority, not guilt).
        severity: {
          "info-bg": "hsl(var(--severity-info-bg) / <alpha-value>)",
          "info-fg": "hsl(var(--severity-info-fg) / <alpha-value>)",
          "low-bg": "hsl(var(--severity-low-bg) / <alpha-value>)",
          "low-fg": "hsl(var(--severity-low-fg) / <alpha-value>)",
          "medium-bg": "hsl(var(--severity-medium-bg) / <alpha-value>)",
          "medium-fg": "hsl(var(--severity-medium-fg) / <alpha-value>)",
          "high-bg": "hsl(var(--severity-high-bg) / <alpha-value>)",
          "high-fg": "hsl(var(--severity-high-fg) / <alpha-value>)",
        },
        // The exercise-book margin rule — decorative signature line only.
        rule: "hsl(var(--rule) / <alpha-value>)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: "var(--font-sans)",
        display: "var(--font-display)",
        mono: "var(--font-mono)",
      },
      // Shell chrome surface (sidebar / topbar tint).
      backgroundColor: {
        sidebar: "hsl(var(--sidebar) / <alpha-value>)",
      },
      // Layered, cool-tinted elevation — cards lift off the paper canvas.
      boxShadow: {
        xs: "var(--shadow-xs)",
        card: "var(--shadow-sm)",
        elevated: "var(--shadow-md)",
        pop: "var(--shadow-lg)",
      },
      // Subtle brand wash for hero / chrome accents.
      backgroundImage: {
        "brand-wash":
          "radial-gradient(120% 120% at 100% 0%, hsl(var(--primary) / 0.06) 0%, transparent 55%)",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.4s cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
