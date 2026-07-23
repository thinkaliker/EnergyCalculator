// Which steps of the page are visible.
//
// The page is a sequence, and showing all of it at once was showing a household
// its plan ranking before it had said which climate zone or generation provider
// it was on — numbers computed from defaults, presented with the same weight as
// numbers computed from answers. Each step is now revealed by the button on the
// step before it, so a figure only appears once the inputs behind it have been
// looked at.
//
// Revealing is one-way. A step that has been opened stays open, because the
// controls in it stay live: changing the climate zone in step 2 re-ranks step 3
// underneath, and collapsing the step you just edited would hide the effect of
// the edit. Only loading a new file resets the sequence, and then it resets to
// the beginning rather than part way.

import { $ } from "./dom.js";
import { state } from "./state.js";
// Called after a step is opened. main.js supplies it — a step becoming visible
// is the moment its charts can be built at a real size, and steps.js cannot
// import main.js to trigger that without a cycle.
let onReveal = () => {};
export const setOnReveal = (fn) => { onReveal = fn; };

// Document order, and the order the next buttons walk. Step 1 is not in the
// list because it is never hidden, and neither is the caveats section — it
// describes the tool rather than the household's answers, so it is readable
// before any file is loaded.
const GATED = ["step-setup", "step-results", "step-load"];

let revealed = 0;

function apply({ redraw = true } = {}) {
  GATED.forEach((id, i) => $(id)?.classList.toggle("hidden", i >= revealed));
  syncStepNav();
  if (!redraw) return;
  // Re-render now that the sections have their real size.
  //
  // A canvas inside a `display: none` section measures 0x0, and Chart.js keeps
  // that size — a section being unhidden is not a container resize it watches
  // for. Asking the existing charts to resize afterwards was not reliable
  // either: there are no rendered pixels to scale up, and forcing a repaint
  // still lost a race roughly one run in six. Building them fresh against a
  // visible container has no such window.
  onReveal();
}

/**
 * Open a step and everything before it. Takes the maximum rather than assigning,
 * so a button pressed twice, or pressed after the user has already scrolled
 * ahead, can never walk the sequence backwards.
 */
export function revealStep(id) {
  const i = GATED.indexOf(id);
  if (i < 0) return;
  revealed = Math.max(revealed, i + 1);
  apply();
}

/** Back to step 1 alone. Called when a new file arrives, so the answers that
 *  described the previous household are re-confirmed rather than inherited. */
export function resetSteps() {
  revealed = 0;
  // No redraw: this runs while a new file is still being read, and the costing
  // that follows will render everything anyway. Asking for one here would cost a
  // full re-rank against a timeline that has not been resolved yet.
  apply({ redraw: false });
}

/**
 * Wire the two kinds of navigation button.
 *
 * `data-next` reveals the step it names and moves to it. `data-scroll` only
 * moves — it is the way back to the file picker from the end of the page, and
 * jumping backwards must not be able to re-hide anything.
 */
export function initStepNav() {
  for (const btn of document.querySelectorAll("[data-next], [data-scroll]")) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.next ?? btn.dataset.scroll;
      if (btn.dataset.next) revealStep(id);
      scrollToStep(id);
    });
  }
  syncStepNav();
}

/**
 * Scroll a step to the top of the view and move focus into it. Shared by the nav
 * buttons and by a fresh file load, which returns the page to step 1 — loading a
 * new file from the bottom of the page would otherwise collapse the steps above
 * and leave the reader stranded in the empty space they left behind. Moving focus
 * as well as scrolling keeps a keyboard user's next Tab continuing from where the
 * page jumped to, not from where they were.
 */
export function scrollToStep(id) {
  const target = $(id);
  if (!target || target.classList.contains("hidden")) return;
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
  target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

/**
 * A navigation button is offered only when its own step is on screen and there
 * is somewhere for it to go. Before a file is loaded that is nowhere: every
 * downstream step would be empty, so offering to jump to one would advertise a
 * result the page does not have yet.
 */
export function syncStepNav() {
  const hasData = state.raw.length > 0;
  for (const nav of document.querySelectorAll(".step-nav")) {
    const btn = nav.querySelector("[data-next], [data-scroll]");
    const ownStep = nav.closest(".step");
    const onScreen = ownStep && !ownStep.classList.contains("hidden");
    // `target` guards the case where step 4 was removed for want of a profile
    // library — its button would otherwise offer a jump to nothing.
    const target = btn && $(btn.dataset.next ?? btn.dataset.scroll);
    nav.classList.toggle("hidden", !(hasData && onScreen && target));
  }
}
