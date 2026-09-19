import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * The light/dark switch, as one component with two placements.
 *
 * ## Why it is a component rather than part of `StaffLayout`
 *
 * It was inline in `StaffLayout`, which meant the only screens that had it were the two staff
 * pages — every student screen (entry, assessment, report), the staff login, and the not-found page
 * had no way to change the theme. "Present in all screens" is a property of the control, not of the
 * staff shell, so the control moved here and each shell decides where to put it.
 *
 * ## The two variants
 *
 * - `topbar` — the inline pill the staff topbar has always rendered. Unchanged, including its
 *   markup, so the staff header looks exactly as it did.
 * - `floating` — the same control pinned to the top-right of a screen that has no topbar. Used by
 *   the student screens and the two public ones.
 *
 * ## Why the state lives here rather than being lifted
 *
 * There is exactly one toggle per screen, so there is nothing to coordinate, and the preference is
 * already shared through `localStorage` rather than through React state — which is what makes the
 * choice survive a page load and carry from a student screen to the staff area. Lifting this into a
 * context or a store would be a second mechanism for a value that already has one, and ARCHITECTURE
 * Section 2 pins no state library.
 *
 * The `typeof window` guard is not defensive noise: the components in this directory are rendered
 * to static markup by the SSR check described in `dashboard`'s `DashboardBody` note, where
 * `window` genuinely does not exist.
 */

/** The stored preference's key. Named once, because a second spelling would be a silent split. */
const THEME_STORAGE_KEY = 'lexora-theme';

type Theme = 'light' | 'dark';

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light';

  return (window.localStorage.getItem(THEME_STORAGE_KEY) as Theme | null) ?? 'light';
}

export function ThemeToggle({ variant = 'topbar' }: { variant?: 'topbar' | 'floating' }) {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const dark = theme === 'dark';

  /*
    The label names the mode; `aria-pressed` says whether it is on.

    Written this way because the previous arrangement contradicted itself. The label changed with
    the theme — "Light mode" while in dark mode — and `aria-pressed` was bound to `dark` at the same
    time, so a screen reader announced "Light mode, pressed", which states that light mode is active
    while the page is dark. It also meant the control had two different accessible names, so it could
    not be found by name after being used once.

    Now the name is stable — "Dark mode" — and `aria-pressed` carries the state, which is the
    arrangement a toggle button is defined by: "Dark mode, pressed" in dark mode, "Dark mode, not
    pressed" in light. The icon still previews what pressing will do, which is the useful visual
    affordance and needs no announcement: it is decorative and hidden from assistive technology.
  */
  return (
    <button
      type="button"
      className={variant === 'floating' ? 'theme-toggle theme-toggle--floating' : 'theme-toggle'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-pressed={dark}
    >
      {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      Dark mode
    </button>
  );
}
