import { useCallback, useEffect, useRef, useState } from 'react';
import type { DraftAnswers, DraftAutosaveBody } from '../../../src/shared/types/draft';
import type { SectionKey } from '../../../src/shared/types/sections';
import { saveSection } from '../api/client';

/**
 * Section-scoped autosave (ARCHITECTURE Section 5, Section 12).
 *
 * The hook owns exactly one section — whichever the student is looking at — and PATCHes only that
 * section. This is the client half of Section 12's rule: the server merges one key into the JSONB
 * column atomically, and this hook is what makes sure each request carries one key. A hook that
 * sent the whole `answers` object would defeat the server's merge entirely, and two tabs open on
 * different sections would silently overwrite one another.
 *
 * ## When it saves
 *
 * - **After ~1.5s of no further edits.** Typing produces a keystroke per character; a request per
 *   keystroke would be dozens of writes for one sentence (Section 14).
 * - **On demand, via `flush`.** Called when the student leaves the field or moves to another
 *   section, where waiting out the debounce would be the wrong behaviour — they have finished with
 *   this section, not paused in it.
 *
 * ## Why `pending` is a ref and not state
 *
 * The payload that still needs sending has to survive a section change and be readable by the
 * flush that change triggers. In state it would be one render behind at exactly the moment it
 * matters: React runs effect cleanups before effects, so the debounce timer for the section being
 * left is cancelled before the flush runs. Holding the payload in a ref means cancelling the timer
 * loses only the *timer*, never the work.
 *
 * ## Status
 *
 * `idle` before anything has been typed, `saving` while a request is in flight or a retry is
 * pending, `saved` once the server has accepted, `error` only after the client has given up.
 * Navigation is never blocked by any of them (Section 5 — "never blocking navigation").
 */

/** How long the student must stop typing before a save is sent (Section 5, Section 14). */
const DEBOUNCE_MS = 1500;

/**
 * How many times one payload is attempted before the failure is surfaced.
 *
 * Section 11 splits auto-save failures from other database failures precisely here: "autosave
 * failures specifically retry client-side before surfacing anything". A dropped request on a campus
 * network is invisible to the student if the retry succeeds, and the alternative — showing an error
 * on the first blip — teaches them to distrust the save indicator.
 */
const MAX_ATTEMPTS = 3;

/** How long to wait before re-attempting, long enough for a blip but not enough to feel stalled. */
const RETRY_DELAY_MS = 4000;

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * The payload as a string, for deciding whether anything has actually changed.
 *
 * Comparing the student's current answers to the last ones the server accepted is what separates
 * "they typed something" from "the page re-rendered" — without it, every render would look like an
 * edit and the page would save in a loop.
 */
function serialize(section: SectionKey, sectionAnswers: unknown): string {
  return JSON.stringify([section, sectionAnswers ?? null]);
}

export function useAutosave<K extends SectionKey>(
  section: K,
  sectionAnswers: DraftAnswers[K],
): { status: AutosaveStatus; flush: () => Promise<void> } {
  const [status, setStatus] = useState<AutosaveStatus>('idle');

  /** Waiting to be sent. See the note above on why this is a ref. */
  const pending = useRef<DraftAutosaveBody | null>(null);
  /** What the server last accepted — seeded with what was loaded, so loading is never an edit. */
  const accepted = useRef<string>(serialize(section, sectionAnswers));
  const attempts = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /**
   * Sends whatever is pending, if anything, and reports the outcome.
   *
   * The explicit type argument is what lets the retry below call this function from inside its own
   * definition: without it TypeScript cannot infer a type for a `const` that refers to itself.
   */
  const send = useCallback<() => Promise<void>>(async () => {
    const body = pending.current;
    if (!body) return;

    stopTimer();
    // Cleared before the request, so a section change arriving mid-flight cannot send it twice.
    pending.current = null;
    setStatus('saving');

    try {
      await saveSection(body);
      attempts.current = 0;
      accepted.current = serialize(body.section, body.sectionAnswers);
      setStatus('saved');
    } catch {
      // Put it back: this payload is still the student's latest work, and a later flush — a
      // section change, a blur, or the retry below — should try it again.
      pending.current = body;
      attempts.current += 1;

      if (attempts.current < MAX_ATTEMPTS) {
        timer.current = setTimeout(() => void send(), RETRY_DELAY_MS);
        return;
      }

      setStatus('error');
    }
  }, [stopTimer]);

  /**
   * Flushes the section being left, and re-seeds `accepted` for the section being entered.
   *
   * Declared **before** the debounce effect below, because effects run in declaration order: the
   * flush has to happen before the debounce effect gets a chance to interpret the new section's
   * answers as an edit. Re-seeding is what makes moving between sections free of writes; without
   * it, entering a section would look exactly like having just typed in it.
   */
  const previousSection = useRef(section);

  useEffect(() => {
    if (previousSection.current === section) return;
    previousSection.current = section;

    const hadPending = pending.current !== null;
    accepted.current = serialize(section, sectionAnswers);

    if (hadPending) {
      void send();
    } else {
      setStatus('idle');
    }
  }, [section, sectionAnswers, send]);

  /** Debounces an edit in the active section. */
  useEffect(() => {
    if (serialize(section, sectionAnswers) === accepted.current) return;

    // The pairing is correct by construction — the caller passes one section and that section's
    // answers — but TypeScript cannot correlate a generic section with the union member it selects.
    pending.current = { section, sectionAnswers } as DraftAutosaveBody;

    stopTimer();
    timer.current = setTimeout(() => void send(), DEBOUNCE_MS);

    return stopTimer;
  }, [section, sectionAnswers, send, stopTimer]);

  /**
   * Best-effort save when the page goes away.
   *
   * A pending edit would otherwise be lost to a navigation the student did not think of as leaving
   * — closing the tab, or following a link out. This cannot be made reliable (a closing page is not
   * obliged to finish a request), which is exactly why the debounce is short and the flush on
   * section change is explicit: this is the last resort, not the mechanism.
   */
  useEffect(() => {
    return () => {
      if (pending.current) void send();
    };
  }, [send]);

  return { status, flush: send };
}
