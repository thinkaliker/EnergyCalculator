// Chart.js wiring. Every function here takes the data it draws as arguments and
// reads no application state — costing and provider selection happen in the
// panels, and this only renders the result.
//
// `Chart` is a global from vendor/chart.umd.js rather than an import, so the
// page keeps working without a bundler.

import { $ } from "./dom.js";
import { hourlyShape, monthlyTotals } from "../period.js";

const charts = {};

// Colours come from the stylesheet so a theme change moves the charts with it.
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function destroy(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

/**
 * Re-measure every chart against its container.
 *
 * Needed because the steps now render before they are shown. A canvas built
 * inside a `display: none` section measures 0x0, and Chart.js keeps that size —
 * it watches for container resizes, and a section being unhidden is not one.
 * Without this, opening step 3 shows empty boxes where the charts should be.
 */
export function resizeCharts() {
  for (const c of Object.values(charts)) {
    c.resize();
    // resize() lays out but does not repaint what was never painted — a chart
    // built at 0x0 has no rendered pixels to scale up. "none" skips the
    // animation, so the chart is complete on the frame the step opens rather
    // than fading in after it.
    c.update("none");
  }
}

function baseOptions(extra = {}) {
  const grid = css("--line");
  const text = css("--text-dim");
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    ...(extra.indexAxis ? { indexAxis: extra.indexAxis } : {}),
    plugins: {
      legend: { labels: { color: text, boxWidth: 12, font: { size: 11 } } },
      ...extra.plugins,
    },
    scales: {
      x: { grid: { color: grid }, ticks: { color: text, font: { size: 11 } }, ...extra.x },
      y: { grid: { color: grid }, ticks: { color: text, font: { size: 11 } }, ...extra.y },
    },
  };
}

// Shades the 4-9pm on-peak window behind the load-shape charts, so it is
// visually obvious whether usage lands in the expensive hours.
const peakBand = {
  id: "peakBand",
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea) return;
    const x1 = scales.x.getPixelForValue(16);
    const x2 = scales.x.getPixelForValue(20);
    ctx.save();
    ctx.fillStyle = css("--peak");
    ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
    ctx.restore();
  },
};

export function drawPlanChart(results) {
  destroy("plans");
  const parts = [
    ["Delivery", "--delivery", (r) => r.lines.delivery],
    ["Generation", "--generation", (r) => r.lines.generation],
    ["Fixed", "--fixed", (r) => r.lines.fixed],
    ["Adders & credits", "--adders", (r) => r.lines.pcia + r.lines.stateRegulatoryFee +
      r.lines.franchiseFeeDifferential + r.lines.franchiseFeeEquivalent + r.lines.baselineCredit],
  ];
  charts.plans = new Chart($("chart-plans"), {
    type: "bar",
    data: {
      labels: results.map((r) => r.planId),
      datasets: parts.map(([label, color, get]) => ({
        label, data: results.map(get), backgroundColor: css(color), borderWidth: 0,
      })),
    },
    options: baseOptions({
      x: { stacked: true },
      y: { stacked: true, ticks: { callback: (v) => `$${v}` } },
    }),
  });
}

export function drawShapeChart(intervals) {
  destroy("shape");
  charts.shape = new Chart($("chart-shape"), {
    type: "line",
    data: {
      labels: [...Array(24).keys()],
      datasets: [{
        label: "Average kWh",
        data: hourlyShape(intervals),
        borderColor: css("--accent"),
        backgroundColor: css("--accent-soft"),
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
      }],
    },
    options: baseOptions({
      plugins: { legend: { display: false } },
      x: { ticks: { callback: (v) => `${v}:00`, maxTicksLimit: 8 } },
    }),
    plugins: [peakBand],
  });
}

export function drawMonthlyChart(intervals) {
  destroy("monthly");
  const months = monthlyTotals(intervals);
  charts.monthly = new Chart($("chart-monthly"), {
    type: "bar",
    data: {
      labels: months.map(([m]) => m),
      datasets: [{
        label: "kWh",
        data: months.map(([, v]) => v),
        backgroundColor: css("--delivery"),
        borderWidth: 0,
      }],
    },
    options: baseOptions({ plugins: { legend: { display: false } } }),
  });
}

export function drawProviderChart(rows) {
  destroy("providers");
  charts.providers = new Chart($("chart-providers"), {
    type: "bar",
    data: {
      labels: rows.map((r) => r.name),
      datasets: [{
        label: "Total",
        data: rows.map((r) => r.total),
        backgroundColor: rows.map((r, i) => (i === 0 ? css("--good") : css("--delivery"))),
        borderWidth: 0,
      }],
    },
    // indexAxis must be set at construction — assigning it afterwards leaves
    // the scales configured for a vertical bar and renders nothing.
    options: baseOptions({
      indexAxis: "y",
      plugins: { legend: { display: false } },
      x: { ticks: { callback: (v) => `$${v}` } },
      y: { ticks: { font: { size: 10 }, autoSkip: false } },
    }),
  });
}

export function drawLoadChart(before, after) {
  destroy("load");
  charts.load = new Chart($("chart-load"), {
    type: "line",
    data: {
      labels: [...Array(24).keys()],
      datasets: [
        { label: "Now", data: hourlyShape(before), borderColor: css("--text-dim"),
          borderDash: [4, 4], pointRadius: 0, borderWidth: 2, tension: 0.3 },
        { label: "With added load", data: hourlyShape(after), borderColor: css("--generation"),
          backgroundColor: css("--warn-soft"), fill: true, pointRadius: 0, borderWidth: 2, tension: 0.3 },
      ],
    },
    options: baseOptions({ x: { ticks: { callback: (v) => `${v}:00`, maxTicksLimit: 8 } } }),
    plugins: [peakBand],
  });
}
