import { useEffect, useState } from 'react';
import type { AnchorHTMLAttributes } from 'react';

/**
 * The application's routing, by hand and on purpose.
 *
 * ARCHITECTURE Section 9 fixes the route table at seven paths and Section 2's dependency list
 * contains no router package, so there is nothing here to install. What routing this SPA actually
 * needs is small: read `window.location.pathname`, re-read it when the History API moves it, and
 * intercept plain left-clicks on internal links. That is this file — about sixty lines against a
 * dependency that would arrive with its own opinions about loaders, data APIs, and nested layouts.
 *
 * ## Why an event rather than a context
 *
 * `pushState` does not fire `popstate`, so a navigation the app performs itself is invisible to
 * every component unless something tells them. A `popstate` listener alone would therefore handle
 * the back button and miss every link. Dispatching a custom event after each `pushState` closes
 * that gap with one subscription in `usePathname`, and keeps `navigate` callable from anywhere —
 * including outside React, which is where an API client's 401 handling would want it.
 *
 * The cost of not having a router is that every route renders the same shell and no data loading
 * is orchestrated. At this size that is the design, not a limitation: each page fetches what it
 * needs on mount (Section 5 — "no global client store").
 */

/** Fired after this module moves the history, so subscribers re-read the location. */
const NAVIGATION_EVENT = 'lexora:navigate';

/**
 * Moves the browser to an in-app path.
 *
 * `replace` for navigations the student should not be able to step back into — the entry page
 * sending a submitted student to their report, for instance, where going "back" would land them on
 * a form for work that is already finished.
 */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace) {
    window.history.replaceState(null, '', to);
  } else {
    window.history.pushState(null, '', to);
  }

  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/** The current in-app path. Subscribes to both the back button and in-app navigation. */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);

    window.addEventListener('popstate', sync);
    window.addEventListener(NAVIGATION_EVENT, sync);

    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, []);

  return pathname;
}

type LinkProps = { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>;

/**
 * An internal link.
 *
 * Renders a real `<a href>`, so the path is visible in the status bar, openable in a new tab, and
 * usable before the bundle loads. Only an unmodified left-click is intercepted: a middle-click, a
 * ctrl/cmd-click, and a shift-click all mean "somewhere else" and are left to the browser.
 */
export function Link({ to, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(event) => {
        onClick?.(event);

        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        event.preventDefault();
        navigate(to);
      }}
    />
  );
}
