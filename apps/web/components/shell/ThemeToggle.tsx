"use client";

import * as React from "react";
import { Sun, Monitor, Moon } from "lucide-react";
import { cn } from "@/lib/utils";

export type ThemePref = "light" | "system" | "dark";

// The pre-paint script in the root layout (ThemeScript) owns theme application
// AND the live OS-change listener; it exposes these two hooks on window so this
// control and the script can never drift on HOW the .dark class is applied.
declare global {
  interface Window {
    __getThemePref?: () => ThemePref;
    __setTheme?: (pref: ThemePref) => void;
  }
}

const OPTIONS: { value: ThemePref; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "Auto", Icon: Monitor },
  { value: "dark", label: "Dark", Icon: Moon },
];

/**
 * A 3-way color-theme control (Light / Auto / Dark). Auto follows the operating
 * system. The choice is stored per-browser in localStorage and applied by the
 * root-layout script, so it works on every page — signed in or not — with no
 * flash on load.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [pref, setPref] = React.useState<ThemePref>("system");
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
    setPref(window.__getThemePref?.() ?? "system");
    // Keep every mounted toggle in sync when any one of them (or the OS) changes.
    const onChange = (e: Event) => setPref((e as CustomEvent<ThemePref>).detail ?? "system");
    window.addEventListener("themechange", onChange);
    return () => window.removeEventListener("themechange", onChange);
  }, []);

  const choose = (p: ThemePref) => {
    window.__setTheme?.(p);
    setPref(p);
  };

  // Until mounted the real (localStorage) selection is unknown on the server, so
  // show the neutral "Auto" as active to avoid a hydration mismatch.
  const current = mounted ? pref : "system";

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border border-border bg-card/85 p-0.5 shadow-sm backdrop-blur",
        className,
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = current === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            onClick={() => choose(value)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
