// Blocking, pre-paint theme bootstrap. Rendered in the root layout so it runs on
// EVERY page (login, public, app) BEFORE the browser paints the body — which is
// what prevents a light→dark flash on load. It is the single owner of how the
// `.dark` class is applied: it reads the saved preference (light | dark |
// system), toggles the class, mirrors it to `data-theme`, keeps following the OS
// while the preference is "system", and exposes `window.__getThemePref` /
// `window.__setTheme` for the ThemeToggle control to reuse. No React here on
// purpose: this must execute synchronously ahead of hydration.
//
// The script itself lives in lib/theme-script.ts so that the CSP hash which
// permits it sits beside the source it is taken from.
import { THEME_SCRIPT } from "@/lib/theme-script";

export function ThemeScript() {
  // eslint-disable-next-line react/no-danger -- reason: intentional pre-paint inline script; content is a fixed constant, no user input.
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
