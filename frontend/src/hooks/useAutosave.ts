import { useCallback, useEffect, useRef, useState } from 'react';
import type { DraftAnswers, DraftAutosaveBody } from '../../../src/shared/types/draft';
import type { SectionKey } from '../../../src/shared/types/sections';
import { ApiError, saveSection } from '../api/client';
import { navigate } from '../router';

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
 *
 * `saved` returns to `idle` after a few seconds, so the indicator describes the section on screen
 * rather than the last request ever accepted.
 *
 * ## Which failures are retried, and which are routed
 *
 * Retrying is for a failure that might not happen twice. A refusal the server will give again for
 * the same payload is not that, and three attempts plus eight seconds of waiting only delay the
 * useful outcome. So `send` reads the status: a `409` means the submission is already final and the
 * student belongs on their report, a `401` means the session is gone and they belong at the entry
 * page, and a `400` is surfaced immediately because the payload itself was refused. Everything else
 * — a dropped request, a `5xx` — keeps the retry policy below.
 *
 * Before this, every failure was retried identically and reported as "check your connection". For a
 * `409` that was actively wrong: the work was not lost and there was nothing wrong with the
 * connection, and the student was left on an assessment that would never accept another write.
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

/**
 * How long "Saved" stays on screen before returning to silence.
 *
 * The indicator sits directly under the section on screen, so it is read as a statement about *that*
 * section. Without a decay it is instead a statement about the last request ever accepted — a
 * student who saved Grammar twenty minutes ago and has been reading Reading since still sees a green
 * "Saved" beside a section they have not touched. Long enough to be noticed after a pause in typing,
 * short enough not to outlive the moment it describes.
 */
const SAVED_DWELL_MS = 4000;

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

  /**
   * Whether there is work the server has not accepted yet.
   *
   * Tracked as its own state rather than derived from `status`, because the two answer different
   * questions. `status` describes what to *show* — and deliberately reports `saved` for a while
   * after a save so the student can see it happened. This describes what would be *lost*, which is
   * the narrower and more literal question, and it has to stay true after a failure: an `error`
   * status means the client has stopped trying, not that the work was saved.
   */
  const [unsaved, setUnsaved] = useState(false);

  /** Waiting to be sent. See the note above on why this is a ref. */
  const pending = useRef<DraftAutosaveBody | null>(null);
  /** What the server last accepted — seeded with what was loaded, so loading is never an edit. */
  const accepted = useRef<string>(serialize(section, sectionAnswers));
  const attempts = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The pending return of `saved` to `idle`. See `SAVED_DWELL_MS`. */
  const decayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const stopDecay = useCallback(() => {
    if (decayTimer.current !== null) {
      clearTimeout(decayTimer.current);
      decayTimer.current = null;
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
    stopDecay();
    // Cleared before the request, so a section change arriving mid-flight cannot send it twice.
    pending.current = null;
    setStatus('saving');

    try {
      await saveSection(body);
      attempts.current = 0;
      accepted.current = serialize(body.section, body.sectionAnswers);
      setUnsaved(false);
      setStatus('saved');
      decayTimer.current = setTimeout(() => {
        setStatus((current) => (current === 'saved' ? 'idle' : current));
      }, SAVED_DWELL_MS);
    } catch (error) {
      /*
        What went wrong decides whether trying again could help.

        Retrying is only correct for a failure that might not happen twice — a dropped request, a
        server having a moment. Every other refusal is deterministic: the same payload sent again
        produces the same refusal, so three attempts and four seconds of waiting buy nothing and
        delay the one thing that does help, which is getting the student off a page that cannot
        accept their work. Section 11's "autosave failures retry client-side" is about the first
        kind; it was never a licence to retry a decision.
      */
      const status = error instanceof ApiError ? error.status : 0;

      if (status === 409) {
        /*
          Already submitted — in another tab, or by a previous visit. The work is not lost and it is
          not unsaved; it is final, and the report is where it can now be read.

          This is the case the old behaviour got worst: the student was told their connection had
          failed and left on an assessment that would never accept another write, with no route to
          the report they had already earned.
        */
        pending.current = null;
        setUnsaved(false);
        setStatus('idle');
        navigate('/report', { replace: true });
        return;
      }

      if (status === 401) {
        // The session ended. Identity verification is the only way back in (Section 9), and the
        // entry page is where the student can provide it.
        pending.current = null;
        setUnsaved(false);
        setStatus('idle');
        navigate('/', { replace: true });
        return;
      }

      // Put it back: this payload is still the student's latest work, and the paths below either
      // retry it or report it — but nothing here throws it away.
      pending.current = body;

      if (status === 400) {
        // The payload itself was refused. A retry would be refused identically, so the failure is
        // surfaced at once rather than after three attempts that cannot succeed.
        setStatus('error');
        return;
      }

      attempts.current += 1;

      if (attempts.current < MAX_ATTEMPTS) {
        timer.current = setTimeout(() => void send(), RETRY_DELAY_MS);
        return;
      }

      setStatus('error');
    }
  }, [stopTimer, stopDecay]);

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
      // Nothing to send, so the indicator is reset here rather than left saying "Saved" about the
      // section the student has just left.
      stopDecay();
      setStatus('idle');
    }
  }, [section, sectionAnswers, send, stopDecay]);

  /** Debounces an edit in the active section. */
  useEffect(() => {
    if (serialize(section, sectionAnswers) === accepted.current) return;

    // The pairing is correct by construction — the caller passes one section and that section's
    // answers — but TypeScript cannot correlate a generic section with the union member it selects.
    pending.current = { section, sectionAnswers } as DraftAutosaveBody;

    // An edit exists that the server has not seen. From here until it is accepted, closing the tab
    // would lose it.
    setUnsaved(true);

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
      stopTimer();
      stopDecay();

      if (pending.current) void send();
    };
  }, [send, stopTimer, stopDecay]);

  /**
   * A warning before the tab closes with work the server has not accepted.
   *
   * The unmount cleanup above is a best-effort save and cannot be made reliable — a closing page is
   * not obliged to finish a request, as its own comment says. That was the entirety of the
   * protection, which meant a student who closed the tab inside the 1.5s debounce window, or during
   * one of the 4s retries, or after they had given up, lost the last thing they wrote with no sign
   * that anything had happened. Principle 2 says the interface may not lose work silently, and this
   * was the one place it still could.
   *
   * Armed only while there is work to lose. A prompt on every navigation would be cried-wolf within
   * a day, and this one has to be believed the once it matters — so it appears for the unsaved
   * window and for a failed save, and never for a tab that is up to date.
   *
   * The wording is the browser's, not this application's: the message has been non-customisable
   * since the API was changed to stop pages writing their own. So nothing here attempts to explain,
   * and the dialog is a stop rather than a sentence.
   */
  useEffect(() => {
    if (!unsaved) return;

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome needs `returnValue` set as well as `preventDefault` called; other browsers use one
      // or the other, which is why both are here.
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', warn);

    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  return { status, flush: send };
}
