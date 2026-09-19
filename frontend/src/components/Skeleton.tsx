/**
 * Placeholder shapes for a page whose data has not arrived.
 *
 * ## Why a shape rather than a sentence
 *
 * Every load in this application used to be one line of text in a card — "Loading dashboard…" — and
 * the page then replaced it with something a completely different size. The text does say what is
 * happening, so this is not about the message; it is about what happens next. A placeholder that
 * already has the shape of the answer means the content arrives *into* a layout instead of pushing
 * one into existence, which is the difference between a page that settles and a page that jumps.
 *
 * ## Why only two shapes
 *
 * A skeleton is a promise about what is coming, so it has to be roughly true and it has to be cheap
 * to keep true. One card shape and one line-list shape cover every load in the product; a bespoke
 * skeleton per screen would be a second layout to maintain for each page, and the first time one
 * drifted from its real content it would be a lie rather than a placeholder.
 *
 * ## Why the shapes are hidden from assistive technology
 *
 * Placeholders carry no information — a screen reader that read eleven empty boxes would be worse
 * off than one that read nothing. The loading *state* is announced once, in words, by the
 * `role="status"` line each caller renders beside them.
 */

/** A run of placeholder lines, the last one short so the block reads as text rather than as a bar. */
export function SkeletonLines({ count }: { count: number }) {
  return (
    <div className="skeleton-lines" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={index === count - 1 ? 'skeleton-line skeleton-line--short' : 'skeleton-line'}
        />
      ))}
    </div>
  );
}

/**
 * One card-shaped placeholder.
 *
 * The card chrome is real — the same `.card` the loaded content uses — so the borders and the
 * spacing between cards do not move when the content arrives. Only what is inside is a placeholder.
 */
export function SkeletonCard({ lines = 3, heading = true }: { lines?: number; heading?: boolean }) {
  return (
    <div className="card">
      {heading && <span className="skeleton-heading" aria-hidden="true" />}
      <SkeletonLines count={lines} />
    </div>
  );
}

/**
 * What a screen reader is told while a skeleton is on screen.
 *
 * Rendered as a live region rather than as a visible caption, because the visible indication is the
 * skeleton itself and repeating it in words would be noise for everyone who can see it.
 */
export function SkeletonStatus({ label }: { label: string }) {
  return (
    <p className="sr-only" role="status" aria-live="polite">
      {label}
    </p>
  );
}
