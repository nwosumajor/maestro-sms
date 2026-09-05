import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A text field that GROWS to fit what is written in it.
 *
 * WHY THIS EXISTS, and why widening the boxes could never have fixed it: a
 * question and its options were `<input>` elements, and **an `<input>` cannot
 * wrap at any width**. Text past the edge scrolls sideways out of view, so a
 * teacher writing a two-line question could only ever see a window of it, and
 * could not read back what they had typed before saving it to a paper a child
 * will sit. The previous round widened those boxes, which helped and did not
 * solve it: the element was the constraint, not the pixels.
 *
 * TWO MECHANISMS, deliberately, because either alone leaves somebody out:
 *
 *   1. `field-sizing: content` — the browser sizes the control to its content
 *      with no JavaScript, no measurement and no reflow on every keystroke.
 *      This is the right answer and it is Chromium-first; Firefox and older
 *      Safari do not have it yet.
 *   2. A height sync for everyone else: set `height:auto`, read `scrollHeight`,
 *      write it back. Runs ONLY where (1) is missing, so a modern browser pays
 *      nothing for the fallback.
 *
 * A school's device fleet is whatever parents and teachers already own, which
 * is exactly the population a Chromium-only feature excludes.
 *
 * `rows={1}` on purpose: a question list is forty of these, and a control that
 * starts three lines tall pushes the paper off the screen before anything has
 * been typed. It grows from one line to as many as the text needs.
 */
const supportsFieldSizing = () =>
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("field-sizing", "content");

export const AutoTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, onChange, ...props }, forwarded) => {
  const inner = React.useRef<HTMLTextAreaElement | null>(null);
  const [needsJs, setNeedsJs] = React.useState(false);

  React.useEffect(() => setNeedsJs(!supportsFieldSizing()), []);

  const fit = React.useCallback((el: HTMLTextAreaElement | null) => {
    if (!el || supportsFieldSizing()) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // Resize on EXTERNAL value changes too, not only on typing. Loading a stored
  // question into the editor sets `value` without an input event, and the
  // scholarship editor PADS the option list when a paper carries more options
  // than the composer's default — both would otherwise open collapsed.
  React.useLayoutEffect(() => { fit(inner.current); }, [fit, props.value, needsJs]);

  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (typeof forwarded === "function") forwarded(el);
        else if (forwarded) (forwarded as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
      }}
      rows={1}
      // `resize-none` because the control sizes itself; leaving the grab handle
      // invites a user to fight it, and a manual height would be overwritten on
      // the next keystroke.
      className={cn(
        "flex w-full resize-none overflow-hidden rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        "[field-sizing:content]",
        className,
      )}
      onChange={(e) => {
        fit(e.currentTarget);
        onChange?.(e);
      }}
      {...props}
    />
  );
});
AutoTextarea.displayName = "AutoTextarea";
