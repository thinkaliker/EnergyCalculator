// The smallest shared layer: DOM lookup, escaping, and the handful of
// formatters every panel uses. Nothing here reads application state, which is
// what lets every other ui/ module import it without creating a cycle.

export const $ = (id) => document.getElementById(id);

export const money = (n) => `$${n.toFixed(2)}`;

export const stat = (value, label) =>
  `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

export const notice = (kind, title, body) =>
  `<div class="notice ${kind}"><strong>${title}</strong><p>${body}</p></div>`;

export const fmtDate = (d) =>
  d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const getJSON = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};
