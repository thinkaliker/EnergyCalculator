// Everything loaded once at boot, plus whatever the current file and selections
// imply. One mutable object rather than a store: the page has a single view and
// no undo, so the ceremony of actions and reducers would buy nothing.
//
// It lives in its own module so the panels can each import it directly instead
// of being handed it through every call. ES module bindings are live, so a
// panel that imports `state` sees writes made anywhere else.

export const state = {
  utility: null,
  overlays: [],      // { file, doc }
  exportTable: null, // NEM 3.0 export prices; absent means NEM 3.0 is unavailable
  cities: null,      // city -> CCA membership and franchise fee
  profiles: [],
  raw: [],           // every interval in the file
  selectedPlanId: null,
  historyIndex: [],  // past rate revisions available, as { provider, effective_date, path }
  history: new Map(),// path -> fetched revision document
  timeline: null,    // resolver over the revisions this file's dates need
};
