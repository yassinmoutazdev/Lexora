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

/**
 * The one route pattern that carries a parameter (ARCHITECTURE Section 9).
 *
 * Declared here rather than in `App.tsx` because two modules need it and they must agree: the route
 * table matches against it, and the dashboard builds links to it. A literal in each would be two
 * spellings of one path, and the day they diverged the dashboard would link to a 404 that no test
 * would catch — `matchPath` would simply return null and `App` would render `NotFound`.
 */
export const SUBMISSION_DETAIL_PATTERN = '/staff/submissions/:submissionId';

/**
 * The URL of one submission's staff page.
 *
 * The counterpart to `matchPath` for the same pattern, so a link is built from the same string the
 * route is matched against. The id is percent-encoded because it is a value travelling in a path
 * segment, not because a submission id is expected to contain anything unusual — the encoding is
 * what makes that an assumption the code does not have to make.
 */
export function submissionDetailPath(submissionId: string): string {
  return `/staff/submissions/${encodeURIComponent(submissionId)}`;
}

/**
 * Matches a route pattern against a pathname, returning its parameters — or null.
 *
 * ## Why this exists at all
 *
 * `App.tsx` reads its route table as a `switch` on the exact pathname, which is enough for six of
 * Section 9's seven paths and cannot express the seventh: `/staff/submissions/:submissionId` carries
 * a submission id, and a `switch` compares whole strings. This is the smallest thing that closes
 * that gap — a segment-by-segment comparison, no dependency, no second routing mechanism.
 *
 * ## Why it is not a full router
 *
 * It supports exactly the syntax Section 9's table uses: literal segments and `:name` parameters.
 * There are no wildcards, no optional segments, no nested patterns, and no query parsing — adding
 * any of those would be building the router this repository deliberately does not have, for a route
 * table that is fixed at seven paths.
 *
 * A `:name` segment must match something non-empty: `/staff/submissions/` is not a submission id,
 * and letting it through would produce a page that fetches an empty id and reports "not found" for
 * a URL that was never a valid one.
 *
 * Parameters are decoded, so an id containing a character a browser percent-encodes still resolves
 * to the value the server issued.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = pattern.split('/');
  const pathSegments = pathname.split('/');

  // A different number of segments cannot match, and checking it first means the loop below can
  // walk both arrays in step without guarding every lookup.
  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};

  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index];
    const actual = pathSegments[index];

    if (expected === undefined || actual === undefined) return null;

    if (expected.startsWith(':')) {
      if (actual.length === 0) return null;
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }

    if (expected !== actual) return null;
  }

  return params;
}

type LinkProps = { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>;/**
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
