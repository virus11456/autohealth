// 7-task analytical dashboard. Each task is a self-contained renderer that
// takes the daily frame and a DOM container, computes everything from scratch,
// and writes the result. Tasks 1-7 follow the brief in the project README.

import { columnValues, rollingMean } from "./aggregator.js";
import { spearman, labelOf } from "./analyzer.js";

// ============================================================
// Stat primitives
// ============================================================

export function pearson(x, y) {
  const n = x.length;
  if (n < 3) return NaN;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return NaN;
  return num / Math.sqrt(dx * dy);
}

// Welch's two-sample t-test. Returns { t, df, p (approximate, two-sided) }.
// p uses a normal-approximation tail (good for df ≥ 30) so we don't need a
// Student-t CDF table; small-sample corrections aren't critical here.
export function welchTTest(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return { t: NaN, df: NaN, p: NaN, na, nb };
  const ma = mean(a), mb = mean(b);
  const va = variance(a, ma), vb = variance(b, mb);
  const se = Math.sqrt(va / na + vb / nb);
  if (se === 0) return { t: NaN, df: NaN, p: NaN, na, nb };
  const t = (ma - mb) / se;
  const df = Math.pow(va / na + vb / nb, 2) /
             (Math.pow(va / na, 2) / (na - 1) + Math.pow(vb / nb, 2) / (nb - 1));
  // Two-sided p via normal approximation
  const z = Math.abs(t);
  const p = Math.min(1, 2 * (1 - normalCdf(z)));
  return { t, df, p, na, nb, ma, mb };
}

function mean(arr) { let s = 0; for (const v of arr) s += v; return s / arr.length; }
function variance(arr, m) {
  let s = 0;
  for (const v of arr) s += (v - m) * (v - m);
  return s / (arr.length - 1);
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}
function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

// Partial correlation r(x, y | controls). Residualize x and y on the controls
// (centered OLS, no intercept), then plain Pearson on residuals.
export function partialCorr(x, y, controls) {
  // align: drop rows where any of x/y/control[i] is NaN
  const arrays = [x, y, ...controls];
  const n = x.length;
  const keepX = [], keepY = [], keepC = controls.map(() => []);
  for (let i = 0; i < n; i++) {
    if (arrays.some((a) => !Number.isFinite(a[i]))) continue;
    keepX.push(x[i]); keepY.push(y[i]);
    for (let k = 0; k < controls.length; k++) keepC[k].push(controls[k][i]);
  }
  if (keepX.length < 6) return { r: NaN, n: keepX.length };
  // Center everything
  const cx = center(keepX);
  const cy = center(keepY);
  const cc = keepC.map(center);
  // Regress cy on cc → residuals
  const resY = residualize(cy, cc);
  const resX = residualize(cx, cc);
  return { r: pearson(resX, resY), n: keepX.length };
}

function center(a) {
  const m = mean(a);
  return a.map((v) => v - m);
}

// Residualize y against centered controls (no intercept term needed since
// everything is centered). Handles 1 or 2 controls; for k > 2 we'd need a
// general linear-algebra solver but the current task set never asks for it.
function residualize(y, controls) {
  if (controls.length === 0) return y.slice();
  if (controls.length === 1) {
    const c = controls[0];
    let scc = 0, syc = 0;
    for (let i = 0; i < y.length; i++) { scc += c[i] * c[i]; syc += y[i] * c[i]; }
    const b = scc === 0 ? 0 : syc / scc;
    return y.map((v, i) => v - b * c[i]);
  }
  if (controls.length === 2) {
    const [c1, c2] = controls;
    let s11 = 0, s22 = 0, s12 = 0, sy1 = 0, sy2 = 0;
    for (let i = 0; i < y.length; i++) {
      s11 += c1[i] * c1[i]; s22 += c2[i] * c2[i]; s12 += c1[i] * c2[i];
      sy1 += y[i] * c1[i]; sy2 += y[i] * c2[i];
    }
    const det = s11 * s22 - s12 * s12;
    if (det === 0) return y.slice();
    const b1 = (sy1 * s22 - sy2 * s12) / det;
    const b2 = (sy2 * s11 - sy1 * s12) / det;
    return y.map((v, i) => v - b1 * c1[i] - b2 * c2[i]);
  }
  throw new Error(`partial corr with ${controls.length} controls not supported`);
}

// ============================================================
// Frame helpers
// ============================================================

// Pair (today's y, lag-d previous-day x). Returns aligned arrays excluding NaN
// pairs. lag=1 means x is yesterday's value, y is today's.
export function laggedPair(rows, xKey, yKey, lag = 1) {
  const xs = [], ys = [];
  for (let i = lag; i < rows.length; i++) {
    const x = rows[i - lag][xKey];
    const y = rows[i][yKey];
    if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
  }
  return { xs, ys };
}

// Group dates into ISO weeks (Mon-start). Returns Map<weekKey, rows[]>.
export function groupByWeek(rows) {
  const out = new Map();
  for (const r of rows) {
    const d = new Date(r.date + "T00:00:00");
    // ISO week: Monday is first day. Set d to nearest Thursday for ISO week-year
    const day = (d.getDay() + 6) % 7; // 0 = Mon
    const monday = new Date(d);
    monday.setDate(d.getDate() - day);
    const key = monday.toISOString().slice(0, 10);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r);
  }
  return out;
}

// Group by year-month YYYY-MM.
export function groupByMonth(rows) {
  const out = new Map();
  for (const r of rows) {
    const key = r.date.slice(0, 7);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r);
  }
  return out;
}

export function meanFinite(arr) {
  let s = 0, n = 0;
  for (const v of arr) if (Number.isFinite(v)) { s += v; n++; }
  return n ? s / n : NaN;
}

export function stdFinite(arr) {
  const finite = arr.filter(Number.isFinite);
  if (finite.length < 2) return NaN;
  const m = mean(finite);
  return Math.sqrt(variance(finite, m));
}

// ============================================================
// Common rendering helpers
// ============================================================

const COLORS = {
  good: "#34c38f", warn: "#f0a020", bad: "#ef4444",
  info: "#4f8cff", muted: "#8b94a7",
  hrv: "#34c38f", rhr: "#ef4444", walking: "#f0a020",
};

const CHART_LAYOUT_BASE = {
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  font: { color: "#e6e9ef", family: "inherit" },
  margin: { l: 50, r: 20, t: 30, b: 40 },
};

function tableHtml(headers, rows, opts = {}) {
  const head = `<tr>${headers.map((h, i) =>
    `<th${opts.numCols && opts.numCols.includes(i) ? ' class="num"' : ""}>${h}</th>`,
  ).join("")}</tr>`;
  const body = rows.map((r) =>
    `<tr>${r.map((c, i) => `<td${opts.numCols && opts.numCols.includes(i) ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`,
  ).join("");
  return `<table class="task-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function callout(severity, html) {
  return `<div class="task-callout ${severity}">${html}</div>`;
}

function emptyState(html) {
  return `<div class="empty-state">${html}</div>`;
}

// ============================================================
// Task 1: 資料健檢
// ============================================================

export function renderTask1(frame, container) {
  if (!frame || !frame.rows.length) {
    container.innerHTML = emptyState("尚未載入資料。");
    return;
  }

  // Coverage per metric
  const skipPattern = /(^date$|^weekday$|^is_weekend$|_baseline30$|_zscore30$|^sleep_start$|^sleep_end$)/;
  const coverage = [];
  for (const c of frame.columns) {
    if (skipPattern.test(c)) continue;
    const vals = columnValues(frame, c);
    const finiteIdx = [];
    for (let i = 0; i < vals.length; i++) if (Number.isFinite(vals[i])) finiteIdx.push(i);
    if (!finiteIdx.length) continue;
    coverage.push({
      key: c,
      label: labelOf(c),
      n: finiteIdx.length,
      pct: (finiteIdx.length / frame.rows.length) * 100,
      first: frame.rows[finiteIdx[0]].date,
      last: frame.rows[finiteIdx[finiteIdx.length - 1]].date,
    });
  }
  coverage.sort((a, b) => b.pct - a.pct);

  // Density gaps: ≥ 7 consecutive NaN per metric, but only over the metric's
  // observed window (don't count "data didn't exist yet" as a gap).
  const gaps = [];
  for (const m of coverage) {
    const vals = columnValues(frame, m.key);
    let firstIdx = -1, lastIdx = -1;
    for (let i = 0; i < vals.length; i++) if (Number.isFinite(vals[i])) { firstIdx = i; break; }
    for (let i = vals.length - 1; i >= 0; i--) if (Number.isFinite(vals[i])) { lastIdx = i; break; }
    if (firstIdx < 0) continue;
    let runStart = -1;
    for (let i = firstIdx; i <= lastIdx; i++) {
      if (!Number.isFinite(vals[i])) {
        if (runStart < 0) runStart = i;
      } else {
        if (runStart >= 0 && i - runStart >= 7) {
          gaps.push({
            key: m.key, label: m.label,
            from: frame.rows[runStart].date, to: frame.rows[i - 1].date,
            days: i - runStart,
          });
        }
        runStart = -1;
      }
    }
    if (runStart >= 0 && lastIdx + 1 - runStart >= 7) {
      gaps.push({
        key: m.key, label: m.label,
        from: frame.rows[runStart].date, to: frame.rows[lastIdx].date,
        days: lastIdx + 1 - runStart,
      });
    }
  }
  gaps.sort((a, b) => b.days - a.days);

  // Outliers in key recovery metrics — |zscore30| > 3
  const outliers = [];
  for (const k of ["resting_hr", "hrv", "sleep_score"]) {
    const z = `${k}_zscore30`;
    if (!frame.columns.includes(z)) continue;
    for (const r of frame.rows) {
      const zv = r[z];
      if (Number.isFinite(zv) && Math.abs(zv) > 3) {
        outliers.push({ date: r.date, key: k, label: labelOf(k), value: r[k], z: zv });
      }
    }
  }
  outliers.sort((a, b) => (a.date < b.date ? 1 : -1));

  // Golden window: longest contiguous run where the 4 core recovery metrics
  // are all populated. These are what most other tasks rely on.
  const coreKeys = ["hrv", "resting_hr", "sleep_score", "daylight"]
    .filter((k) => frame.columns.includes(k));
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < frame.rows.length; i++) {
    const allOk = coreKeys.every((k) => Number.isFinite(frame.rows[i][k]));
    if (allOk) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  const golden = bestLen >= 30 ? {
    from: frame.rows[bestStart].date,
    to: frame.rows[bestStart + bestLen - 1].date,
    days: bestLen,
  } : null;

  // ---- Render ----
  let html = `<h2 class="task-title">🩺 任務 1：資料健檢</h2>`;
  html += `<p class="task-intro">確認哪些指標有足夠資料、哪些時段有斷層、哪些日期可能是離群值。其他 6 個任務都靠這個基底跑。</p>`;

  // Golden window callout
  if (golden) {
    html += callout("good",
      `<strong>📅 建議分析黃金窗口</strong>　${golden.from} → ${golden.to}（共 ${golden.days} 天）<br>` +
      `<span class="muted">這段時間 HRV / 靜息心率 / 睡眠分數 / 日照 都有資料，做相關性分析最乾淨。</span>`);
  } else {
    html += callout("warn",
      `<strong>⚠ 資料還太少</strong>　目前還找不到 4 個核心指標都連續 ≥ 30 天的時段。建議先繼續累積資料。`);
  }

  // Coverage table
  html += `<h3>📊 指標涵蓋率（${coverage.length} 個）</h3>`;
  const covRows = coverage.map((m) => [
    m.label + ` <code class="muted">${m.key}</code>`,
    m.n.toLocaleString(),
    m.pct.toFixed(1) + "%",
    m.first,
    m.last,
  ]);
  html += tableHtml(["指標", "非空天數", "涵蓋率", "首筆", "末筆"], covRows, { numCols: [1, 2] });

  // Density gaps
  html += `<h3>🕳 資料密度斷層（連續 ≥ 7 天空值）</h3>`;
  if (!gaps.length) {
    html += `<p class="muted">沒有找到顯著斷層 — 各指標在其資料期間內都很連續。</p>`;
  } else {
    const gapRows = gaps.slice(0, 30).map((g) => [
      g.label, g.from, g.to, `${g.days} 天`,
    ]);
    html += tableHtml(["指標", "起", "迄", "天數"], gapRows, { numCols: [3] });
    if (gaps.length > 30) html += `<p class="muted">（顯示前 30 筆，共 ${gaps.length} 筆）</p>`;
  }

  // Outliers
  html += `<h3>🚨 離群值（|z-score30| > 3）</h3>`;
  html += `<p class="muted">針對 靜息心率 / HRV / 睡眠分數 三個關鍵指標。極端值可能是真實事件（例如生病、熬夜）也可能是資料錯誤，建議手動檢查。</p>`;
  if (!outliers.length) {
    html += `<p class="muted">沒有偵測到 |z| > 3 的極端離群值。</p>`;
  } else {
    const outRows = outliers.slice(0, 50).map((o) => [
      o.date, o.label, fmt(o.value), `${o.z >= 0 ? "+" : ""}${o.z.toFixed(2)}σ`,
    ]);
    html += tableHtml(["日期", "指標", "當日值", "z-score"], outRows, { numCols: [2, 3] });
    if (outliers.length > 50) html += `<p class="muted">（顯示前 50 筆，共 ${outliers.length} 筆）</p>`;
  }

  container.innerHTML = html;
}

function fmt(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

// ============================================================
// Tasks 2–7 (placeholders — implemented in subsequent commits)
// ============================================================

const PENDING_NOTE = (n, name) => `
<h2 class="task-title">${name}</h2>
<p class="task-intro task-pending">此分頁正在分階段實作中。本 commit 完成 Task 1，後續 commits 會逐一補齊 Task 2–7。</p>`;

// Tiny helper: per-pair Spearman dropping NaN, on aligned arrays.
function spearmanPair(a, b) {
  return spearman(a, b);
}

// Status badge from a z-score, given which direction is "good".
// Returns { emoji, label, cls } where cls maps to .status-{good,fair,low,alert,empty}.
function statusFromZ(z, higherIsBetter = true) {
  if (!Number.isFinite(z)) return { emoji: "⚪", label: "資料不足", cls: "empty" };
  const dir = higherIsBetter ? z : -z;
  if (dir >= 1) return { emoji: "🟢", label: "良好", cls: "good" };
  if (dir >= -1) return { emoji: "🔵", label: "平穩", cls: "fair" };
  if (dir >= -2) return { emoji: "🟡", label: "偏離基線", cls: "low" };
  return { emoji: "🔴", label: "警戒", cls: "alert" };
}

// Latest finite value index — usually the most recent day with data.
function lastFiniteIdx(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return i;
  return -1;
}

// Metric card with embedded sparkline. The card is self-contained: pass
// dates + raw + smooth arrays plus today's z-score and the card decides the
// big number / delta / status pill. Chart renders into a child div whose id
// is `chartId` once the card is in the DOM.
function metricCard({ chartId, label, unit, dates, raw, smooth, baselineLabel = "30 天基線",
                     higherIsBetter = true, hint = "" }) {
  const i = lastFiniteIdx(raw);
  const value = i >= 0 ? raw[i] : NaN;
  const baseline = i >= 0 ? smooth[i] : NaN;
  const std = stdFinite(raw);
  const z = (Number.isFinite(value) && Number.isFinite(baseline) && Number.isFinite(std) && std > 0)
    ? (value - baseline) / std : NaN;
  const status = statusFromZ(z, higherIsBetter);
  const delta = (Number.isFinite(value) && Number.isFinite(baseline)) ? value - baseline : NaN;
  const deltaSign = (higherIsBetter ? delta : -delta) >= 0 ? "good" : "bad";
  const deltaClass = Number.isFinite(delta) ? deltaSign : "muted";
  const fmtV = (v) => !Number.isFinite(v) ? "—" :
    Math.abs(v) >= 100 ? v.toFixed(0) :
    Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `
    <div class="metric-card status-${status.cls}">
      <div class="metric-head">
        <span class="metric-label">${label}</span>
        <span class="metric-status">${status.emoji} ${status.label}</span>
      </div>
      <div class="metric-value">
        ${fmtV(value)}<span class="metric-unit">${unit}</span>
      </div>
      <div class="metric-meta">
        <span class="metric-delta ${deltaClass}">
          ${Number.isFinite(delta) ? (delta >= 0 ? "↑ +" : "↓ ") + fmtV(Math.abs(delta)) + " " + unit : ""}
        </span>
        <span class="muted">vs ${baselineLabel} ${fmtV(baseline)}${unit}</span>
      </div>
      <div id="${chartId}" class="metric-chart"></div>
      ${hint ? `<div class="metric-hint muted">${hint}</div>` : ""}
    </div>`;
}

// Render a sparkline-style line chart into the given div.
function drawMetricChart(divId, dates, raw, smooth, color, opts = {}) {
  const div = document.getElementById(divId);
  if (!div || typeof Plotly === "undefined") return;
  const traces = [
    { x: dates, y: raw, mode: "markers", type: "scatter",
      marker: { size: 2.5, opacity: 0.35, color }, name: "原始", showlegend: false,
      hovertemplate: `%{x}<br>%{y:.2f}<extra></extra>` },
    { x: dates, y: smooth, mode: "lines", type: "scatter",
      line: { width: 2, color }, name: "30 天均", showlegend: false,
      hovertemplate: `%{x}<br>30d 均: %{y:.2f}<extra></extra>` },
  ];
  Plotly.newPlot(div, traces, {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#8b94a7", family: "inherit", size: 10 },
    margin: { l: 36, r: 8, t: 6, b: 22 },
    xaxis: { gridcolor: "rgba(127,127,127,0.08)", tickfont: { size: 9 }, fixedrange: true },
    yaxis: { gridcolor: "rgba(127,127,127,0.08)", tickfont: { size: 9 }, fixedrange: true },
    height: opts.height || 140,
    hovermode: "x unified",
    showlegend: false,
  }, { displaylogo: false, responsive: true, displayModeBar: false });
}

function corrCellColor(r) {
  if (!Number.isFinite(r)) return "var(--muted)";
  if (Math.abs(r) < 0.15) return "var(--muted)";
  return r > 0 ? "var(--info)" : "var(--bad)";
}

function corrMatrixHtml(labels, series) {
  const n = series.length;
  const m = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      if (i === j) { row.push({ r: 1, n: NaN }); continue; }
      if (j < i) { row.push(m[j][i]); continue; }
      row.push(spearmanPair(series[i], series[j]));
    }
    m.push(row);
  }
  let html = '<table class="task-table"><thead><tr><th></th>';
  for (const l of labels) html += `<th class="num">${l}</th>`;
  html += "</tr></thead><tbody>";
  for (let i = 0; i < n; i++) {
    html += `<tr><th>${labels[i]}</th>`;
    for (let j = 0; j < n; j++) {
      const cell = m[i][j];
      const r = cell.r;
      const text = i === j ? "—" : Number.isFinite(r)
        ? `<span style="color:${corrCellColor(r)}">${r >= 0 ? "+" : ""}${r.toFixed(2)}</span>`
        : "—";
      html += `<td class="num">${text}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

// Color a z-score by whether the direction is "good" or "bad" for the metric.
// higherIsBetter = true → +z is good (HRV, sleep_score). false → -z is good (RHR, walking_hr).
function fmtZ(z, higherIsBetter = false) {
  if (!Number.isFinite(z)) return "—";
  const sign = z >= 0 ? "+" : "";
  const good = higherIsBetter ? z > 0 : z < 0;
  return `<span style="color:${good ? "var(--good)" : "var(--bad)"}">${sign}${z.toFixed(2)}σ</span>`;
}

export function renderTask2(frame, container) {
  if (!frame || !frame.rows.length) {
    container.innerHTML = emptyState("尚未載入資料 / 區間太短。");
    return;
  }

  const required = ["hrv", "resting_hr", "walking_hr"];
  const missing = required.filter((c) => !frame.columns.includes(c) ||
    columnValues(frame, c).every((v) => !Number.isFinite(v)));
  if (missing.length) {
    container.innerHTML = `<h2 class="task-title">🔋 任務 2：核心 Readiness 三角</h2>` +
      callout("warn",
        `<strong>⚠ 缺少指標：</strong>${missing.map(labelOf).join(" / ")}<br>` +
        `這個任務需要 HRV / 靜息心率 / 步行心率三者都有資料才能跑。靜息與步行心率要 Apple Watch 較長期戴用才會累積。`);
    return;
  }

  const dates = frame.rows.map((r) => r.date);
  const hrv = columnValues(frame, "hrv");
  const rhr = columnValues(frame, "resting_hr");
  const walking = columnValues(frame, "walking_hr");
  const hrvSm = rollingMean(hrv, 30);
  const rhrSm = rollingMean(rhr, 30);
  const walkingSm = rollingMean(walking, 30);

  // z-score series for correlation matrix + fatigue / super-recovery detection
  const hrvZ = columnValues(frame, "hrv_zscore30");
  const rhrZ = columnValues(frame, "resting_hr_zscore30");
  const walkingZ = columnValues(frame, "walking_hr_zscore30");

  // Fatigue days: HRV ↓ AND RHR ↑ AND walking_HR ↑ — the "三者反向" pattern
  // the brief calls accumulated fatigue / pre-illness signal.
  const fatigueDays = [];
  for (let i = 0; i < frame.rows.length; i++) {
    if (Number.isFinite(hrvZ[i]) && Number.isFinite(rhrZ[i]) && Number.isFinite(walkingZ[i]) &&
        hrvZ[i] < -1 && rhrZ[i] > 1 && walkingZ[i] > 1) {
      fatigueDays.push({
        date: frame.rows[i].date,
        hrv: hrv[i], rhr: rhr[i], walking: walking[i],
        hrvZ: hrvZ[i], rhrZ: rhrZ[i], walkingZ: walkingZ[i],
      });
    }
  }

  // Super-recovery days: HRV high + RHR low. Look at that day's sleep features
  // (which represent the previous night's sleep ending in the morning).
  const superDays = [];
  for (let i = 0; i < frame.rows.length; i++) {
    if (Number.isFinite(hrvZ[i]) && Number.isFinite(rhrZ[i]) &&
        hrvZ[i] > 1 && rhrZ[i] < -1) {
      const r = frame.rows[i];
      superDays.push({
        date: r.date,
        hrv: hrv[i], rhr: rhr[i],
        hrvZ: hrvZ[i], rhrZ: rhrZ[i],
        sleepScore: r.sleep_score,
        sleepHours: r.sleep_hours,
        deepMin: r.sleep_deep_minutes,
        remMin: r.sleep_rem_minutes,
      });
    }
  }

  // Compare super-recovery sleep stats vs overall: helps see if the pattern
  // really has anything in common (e.g., longer sleep, more deep).
  const overallSleep = {
    score: meanFinite(columnValues(frame, "sleep_score")),
    hours: meanFinite(columnValues(frame, "sleep_hours")),
    deep:  meanFinite(columnValues(frame, "sleep_deep_minutes")),
    rem:   meanFinite(columnValues(frame, "sleep_rem_minutes")),
  };
  const superSleep = superDays.length ? {
    score: meanFinite(superDays.map((d) => d.sleepScore)),
    hours: meanFinite(superDays.map((d) => d.sleepHours)),
    deep:  meanFinite(superDays.map((d) => d.deepMin)),
    rem:   meanFinite(superDays.map((d) => d.remMin)),
  } : null;

  // ---- Render ----
  let html = `<h2 class="task-title">🔋 任務 2：核心 Readiness 三角</h2>`;
  html += `<p class="task-intro">HRV ↑ + 靜息心率 ↓ + 同強度步行心率 ↓ = 身體狀態進步；三者反向 = 累積疲勞或感冒前兆（通常比體感早 1-2 天）。</p>`;

  // Card row: today's value + delta vs 30-day baseline + mini chart, per metric.
  html += `<h3>📊 黃金三角現況</h3>`;
  html += `<div class="metric-grid">`;
  html += metricCard({
    chartId: "t2-chart-hrv", label: "HRV", unit: " ms",
    dates, raw: hrv, smooth: hrvSm, higherIsBetter: true,
    hint: "心率變異 ↑ = 自律神經彈性好",
  });
  html += metricCard({
    chartId: "t2-chart-rhr", label: "靜息心率", unit: " bpm",
    dates, raw: rhr, smooth: rhrSm, higherIsBetter: false,
    hint: "靜息心率 ↓ = 心肺基底進步",
  });
  html += metricCard({
    chartId: "t2-chart-walking", label: "步行心率", unit: " bpm",
    dates, raw: walking, smooth: walkingSm, higherIsBetter: false,
    hint: "同強度步行心率 ↓ = 心肺效率提升",
  });
  html += `</div>`;

  // Correlation matrix on z-scores
  html += `<h3>🔗 z-score 相關矩陣</h3>`;
  html += `<p class="muted" style="margin: 0 0 8px 0;">用 30 天 z-score 算 Spearman；藍 = 正相關，紅 = 負相關。健康狀況下：HRV ↔ RHR 應該是負，HRV ↔ 步行 HR 應該是負，RHR ↔ 步行 HR 應該是正。</p>`;
  html += corrMatrixHtml(["HRV", "靜息 HR", "步行 HR"], [hrvZ, rhrZ, walkingZ]);

  // Fatigue days
  html += `<h3>⚠ 典型疲勞日（HRV z &lt; -1 且 RHR z &gt; +1 且 步行 HR z &gt; +1）</h3>`;
  if (!fatigueDays.length) {
    html += `<p class="muted">沒有偵測到符合條件的累積疲勞日。資料期間內身體大多還在 OK 範圍，或單一指標惡化但沒三者同時。</p>`;
  } else {
    html += `<p class="muted" style="margin:0 0 8px 0;">三個訊號同時偏離個人基線，常常比體感早 1-2 天出現。建議手動回想當週的工作量 / 訓練 / 睡眠 / 壓力。</p>`;
    const rows = fatigueDays.slice(-50).reverse().map((d) => [
      d.date,
      `${d.hrv.toFixed(1)} ms ${fmtZ(d.hrvZ, true)}`,
      `${d.rhr.toFixed(0)} bpm ${fmtZ(d.rhrZ, false)}`,
      `${d.walking.toFixed(0)} bpm ${fmtZ(d.walkingZ, false)}`,
    ]);
    html += tableHtml(["日期", "HRV", "靜息 HR", "步行 HR"], rows, { numCols: [1, 2, 3] });
    if (fatigueDays.length > 50) {
      html += `<p class="muted">（顯示最近 50 筆，共 ${fatigueDays.length} 筆）</p>`;
    }
  }

  // Super-recovery days
  html += `<h3>✨ 典型超恢復日（HRV z &gt; +1 且 RHR z &lt; -1）</h3>`;
  if (!superDays.length) {
    html += `<p class="muted">資料期間內沒有同時 HRV 高 + RHR 低的「超恢復日」。</p>`;
  } else {
    if (superSleep) {
      const dHours = superSleep.hours - overallSleep.hours;
      const dDeep = superSleep.deep - overallSleep.deep;
      const dRem = superSleep.rem - overallSleep.rem;
      const dScore = superSleep.score - overallSleep.score;
      html += callout("good",
        `<strong>超恢復日的睡眠特徵</strong>（共 ${superDays.length} 天）<br>` +
        `這些日子的當晚 / 前一晚睡眠表現對比整體平均：<br>` +
        `<span class="muted">睡眠時數</span> ${superSleep.hours?.toFixed(1) ?? "—"}h ` +
        `<strong style="color:${dHours >= 0 ? "var(--good)" : "var(--bad)"}">(${dHours >= 0 ? "+" : ""}${dHours?.toFixed(1) ?? "—"}h vs 平均)</strong>　·　` +
        `<span class="muted">深睡</span> ${superSleep.deep?.toFixed(0) ?? "—"} 分 ` +
        `<strong style="color:${dDeep >= 0 ? "var(--good)" : "var(--bad)"}">(${dDeep >= 0 ? "+" : ""}${dDeep?.toFixed(0) ?? "—"} 分)</strong>　·　` +
        `<span class="muted">REM</span> ${superSleep.rem?.toFixed(0) ?? "—"} 分 ` +
        `<strong style="color:${dRem >= 0 ? "var(--good)" : "var(--bad)"}">(${dRem >= 0 ? "+" : ""}${dRem?.toFixed(0) ?? "—"} 分)</strong>　·　` +
        `<span class="muted">睡眠分數</span> ${superSleep.score?.toFixed(0) ?? "—"} ` +
        `<strong style="color:${dScore >= 0 ? "var(--good)" : "var(--bad)"}">(${dScore >= 0 ? "+" : ""}${dScore?.toFixed(0) ?? "—"})</strong>`);
    }
    const rows = superDays.slice(-50).reverse().map((d) => [
      d.date,
      `${d.hrv.toFixed(1)} ms ${fmtZ(d.hrvZ, true)}`,
      `${d.rhr.toFixed(0)} bpm ${fmtZ(d.rhrZ, false)}`,
      Number.isFinite(d.sleepScore) ? d.sleepScore.toFixed(0) : "—",
      Number.isFinite(d.sleepHours) ? d.sleepHours.toFixed(1) + "h" : "—",
      Number.isFinite(d.deepMin) ? d.deepMin.toFixed(0) + "m" : "—",
      Number.isFinite(d.remMin) ? d.remMin.toFixed(0) + "m" : "—",
    ]);
    html += tableHtml(["日期", "HRV", "靜息 HR", "睡眠分數", "睡眠時長", "深睡", "REM"], rows,
      { numCols: [1, 2, 3, 4, 5, 6] });
    if (superDays.length > 50) {
      html += `<p class="muted">（顯示最近 50 筆，共 ${superDays.length} 筆）</p>`;
    }
  }

  container.innerHTML = html;

  // Charts must render after DOM is in place
  drawMetricChart("t2-chart-hrv", dates, hrv, hrvSm, "#34c38f");
  drawMetricChart("t2-chart-rhr", dates, rhr, rhrSm, "#ef4444");
  drawMetricChart("t2-chart-walking", dates, walking, walkingSm, "#f0a020");
}
// Status from a Spearman / partial-corr r value.
function corrStatus(r) {
  if (!Number.isFinite(r)) return { emoji: "⚪", label: "資料不足", cls: "empty" };
  const abs = Math.abs(r);
  if (abs >= 0.5) return r > 0
    ? { emoji: "🟢", label: "強正相關", cls: "good" }
    : { emoji: "🔴", label: "強負相關", cls: "alert" };
  if (abs >= 0.3) return r > 0
    ? { emoji: "🔵", label: "中等正相關", cls: "fair" }
    : { emoji: "🟡", label: "中等負相關", cls: "low" };
  if (abs >= 0.15) return { emoji: "⚪", label: "弱相關", cls: "fair" };
  return { emoji: "⚪", label: "不顯著", cls: "empty" };
}

// Stat card: like metricCard but for derived statistics (no raw value /
// sparkline). Shows a label, a big stat, optional subtitle, status pill, hint.
function statCard({ label, value, subtitle = "", status, hint = "" }) {
  return `
    <div class="metric-card status-${status.cls}">
      <div class="metric-head">
        <span class="metric-label">${label}</span>
        <span class="metric-status">${status.emoji} ${status.label}</span>
      </div>
      <div class="metric-value">${value}</div>
      <div class="metric-meta">${subtitle ? `<span class="muted">${subtitle}</span>` : ""}</div>
      ${hint ? `<div class="metric-hint muted">${hint}</div>` : ""}
    </div>`;
}

export function renderTask3(frame, container) {
  if (!frame || frame.rows.length < 14) {
    container.innerHTML = `<h2 class="task-title">💤 任務 3：睡眠 → 隔日恢復</h2>` +
      emptyState("資料量太少，至少需要 14 天才能跑 lag-1 相關分析。");
    return;
  }

  const required = ["sleep_hours", "sleep_deep_minutes", "sleep_rem_minutes",
                    "sleep_score", "hrv", "resting_hr"];
  const missing = required.filter((c) => !frame.columns.includes(c) ||
    !columnValues(frame, c).some(Number.isFinite));
  if (missing.length) {
    container.innerHTML = `<h2 class="task-title">💤 任務 3：睡眠 → 隔日恢復</h2>` +
      callout("warn", `<strong>⚠ 缺少指標：</strong>${missing.map(labelOf).join(" / ")}<br>` +
        `這個任務需要 睡眠時長 / 深睡 / REM / 睡眠分數 / HRV / 靜息心率 都有資料才能跑。`);
    return;
  }

  // Build aligned arrays: yesterday's sleep_* paired with today's recovery
  const hrvToday = [], rhrToday = [];
  const sleepHoursY = [], sleepDeepY = [], sleepRemY = [], sleepScoreY = [];
  const deepRemRatioY = [];
  for (let i = 1; i < frame.rows.length; i++) {
    const t = frame.rows[i], y = frame.rows[i - 1];
    hrvToday.push(t.hrv); rhrToday.push(t.resting_hr);
    sleepHoursY.push(y.sleep_hours);
    sleepDeepY.push(y.sleep_deep_minutes);
    sleepRemY.push(y.sleep_rem_minutes);
    sleepScoreY.push(y.sleep_score);
    const totalMin = y.sleep_hours * 60;
    deepRemRatioY.push(totalMin > 0
      ? (y.sleep_deep_minutes + y.sleep_rem_minutes) / totalMin : NaN);
  }

  // 3 hypotheses (partial corr against today's HRV)
  const hypA = partialCorr(sleepHoursY, hrvToday, [sleepDeepY, sleepRemY]);
  const hypB = partialCorr(sleepDeepY, hrvToday, [sleepHoursY, sleepRemY]);
  // Hypothesis C: ratio is already a derived combo, no further controls
  const hypC = (() => {
    const xs = [], ys = [];
    for (let i = 0; i < hrvToday.length; i++) {
      if (Number.isFinite(deepRemRatioY[i]) && Number.isFinite(hrvToday[i])) {
        xs.push(deepRemRatioY[i]); ys.push(hrvToday[i]);
      }
    }
    if (xs.length < 6) return { r: NaN, n: xs.length };
    return { r: pearson(xs, ys), n: xs.length };
  })();

  const hypotheses = [
    { id: "A", name: "總睡眠時長", desc: "(控制深睡 / REM)",
      hint: "睡時數越長，隔日 HRV 越高",
      r: hypA.r, n: hypA.n },
    { id: "B", name: "深睡時長", desc: "(控制總時長 / REM)",
      hint: "即使總時長不變，深睡分鐘多 → 隔日恢復更好",
      r: hypB.r, n: hypB.n },
    { id: "C", name: "深睡 + REM 比", desc: "(深睡 + REM) / 總時長",
      hint: "高效睡眠（深 + REM 佔比高）→ 隔日恢復更好",
      r: hypC.r, n: hypC.n },
  ];
  const winner = [...hypotheses].sort((a, b) =>
    (Number.isFinite(b.r) ? Math.abs(b.r) : -1) - (Number.isFinite(a.r) ? Math.abs(a.r) : -1))[0];

  // lag-1 Spearman correlation table: rows = sleep metrics, cols = recovery
  const sleepKeys = [
    ["sleep_hours", "睡眠時數", sleepHoursY],
    ["sleep_deep_minutes", "深睡分鐘", sleepDeepY],
    ["sleep_rem_minutes", "REM 分鐘", sleepRemY],
    ["sleep_score", "睡眠分數", sleepScoreY],
  ];
  const recoveryKeys = [
    ["hrv", "HRV (今日)", hrvToday, true],
    ["resting_hr", "靜息心率 (今日)", rhrToday, false],
  ];
  if (frame.columns.includes("walking_hr")) {
    const walkingToday = [];
    for (let i = 1; i < frame.rows.length; i++) walkingToday.push(frame.rows[i].walking_hr);
    recoveryKeys.push(["walking_hr", "步行心率 (今日)", walkingToday, false]);
  }

  // sleep_score binning → next-day HRV box plot
  const bins = [
    { label: "<60", lo: -Infinity, hi: 60, color: "#ef4444", values: [] },
    { label: "60-75", lo: 60, hi: 75, color: "#f0a020", values: [] },
    { label: "75-85", lo: 75, hi: 85, color: "#4f8cff", values: [] },
    { label: ">85", lo: 85, hi: Infinity, color: "#34c38f", values: [] },
  ];
  for (let i = 0; i < hrvToday.length; i++) {
    const sc = sleepScoreY[i], hrv = hrvToday[i];
    if (!Number.isFinite(sc) || !Number.isFinite(hrv)) continue;
    for (const b of bins) {
      if (sc >= b.lo && sc < b.hi) { b.values.push(hrv); break; }
    }
  }
  const binSummary = bins.map((b) => ({
    label: b.label, n: b.values.length,
    mean: b.values.length ? meanFinite(b.values) : NaN,
  }));

  // ---- Render ----
  let html = `<h2 class="task-title">💤 任務 3：睡眠 → 隔日恢復</h2>`;
  html += `<p class="task-intro">把昨晚的睡眠特徵跟今天的恢復指標對齊（lag = 1 天），驗證「對你而言」哪個睡眠面向最值得優化。</p>`;

  // 3 hypothesis cards
  html += `<h3>🧪 三個假設：哪個睡眠面向對隔日 HRV 最重要？</h3>`;
  html += `<p class="muted">Partial correlation 排除其他睡眠變數的線性影響後，跟今天 HRV 的相關係數。|r| 越高 = 越獨立重要。</p>`;
  html += `<div class="metric-grid">`;
  for (const h of hypotheses) {
    const status = corrStatus(h.r);
    const rText = Number.isFinite(h.r) ? `${h.r >= 0 ? "+" : ""}${h.r.toFixed(2)}` : "—";
    html += statCard({
      label: `假設 ${h.id}：${h.name}`,
      value: rText,
      subtitle: `partial r　${h.desc}　·　n = ${h.n}`,
      status, hint: h.hint,
    });
  }
  html += `</div>`;

  // Conclusion callout
  if (Number.isFinite(winner.r) && Math.abs(winner.r) >= 0.15) {
    html += callout("good",
      `<strong>結論</strong>　對你而言，<strong>「${winner.name}」</strong>對隔日 HRV 影響最強（partial r = ${winner.r.toFixed(2)}, n = ${winner.n}）。優先優化這個面向，會比追求其他面向更直接看到隔天恢復改善。`);
  } else {
    html += callout("warn",
      `<strong>結論</strong>　三個假設的偏相關都偏弱（|r| < 0.15），可能需要更多資料；或這三個睡眠維度對你的 HRV 都沒單獨突出影響——可以試試看其他變因（運動量 / 壓力）。`);
  }

  // lag-1 correlation matrix
  html += `<h3>📋 lag-1 Spearman 相關矩陣</h3>`;
  html += `<p class="muted">列：昨晚睡眠指標　·　欄：今天的恢復指標。藍 = 正相關，紅 = 負相關。星號 * 代表 p &lt; 0.05。</p>`;
  let mtxHtml = `<table class="task-table"><thead><tr><th>　</th>`;
  for (const [, label] of recoveryKeys) mtxHtml += `<th class="num">${label}</th>`;
  mtxHtml += `</tr></thead><tbody>`;
  for (const [_, sLabel, sArr] of sleepKeys) {
    mtxHtml += `<tr><th>${sLabel}</th>`;
    for (const [, , rArr, higherBetter] of recoveryKeys) {
      const { r, p, n } = spearmanPair(sArr, rArr);
      const sig = Number.isFinite(p) && p < 0.05 ? "*" : "";
      const txt = Number.isFinite(r)
        ? `<span style="color:${corrCellColor(r)}">${r >= 0 ? "+" : ""}${r.toFixed(2)}${sig}</span><br><span class="muted" style="font-size:0.7rem">n=${n}</span>`
        : "—";
      mtxHtml += `<td class="num">${txt}</td>`;
    }
    mtxHtml += `</tr>`;
  }
  mtxHtml += `</tbody></table>`;
  html += mtxHtml;

  // Sleep score binning boxplot
  html += `<h3>📊 睡眠分數分箱 → 隔日 HRV 分佈</h3>`;
  html += `<p class="muted">把昨晚睡眠分數分 4 箱，看隔天 HRV 的分佈。理想：分數越高，HRV 中位數應該越高。</p>`;
  // Bin summary table (mean per bin)
  const binRows = binSummary.map((b) =>
    [b.label, b.n, Number.isFinite(b.mean) ? b.mean.toFixed(1) + " ms" : "—"]);
  html += tableHtml(["睡眠分數區間", "天數", "隔日 HRV 平均"], binRows, { numCols: [1, 2] });
  html += `<div id="t3-box" class="task-chart"></div>`;

  container.innerHTML = html;

  // Render boxplot via Plotly
  if (typeof Plotly !== "undefined") {
    const div = document.getElementById("t3-box");
    if (div) {
      const traces = bins
        .filter((b) => b.values.length > 0)
        .map((b) => ({
          type: "box", y: b.values, name: b.label,
          marker: { color: b.color }, line: { color: b.color },
          boxpoints: "outliers", boxmean: true,
        }));
      Plotly.newPlot(div, traces, {
        paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
        font: { color: "#e6e9ef", family: "inherit", size: 11 },
        margin: { l: 50, r: 20, t: 20, b: 40 },
        xaxis: { title: { text: "昨晚睡眠分數", font: { size: 11 } },
                 gridcolor: "rgba(127,127,127,0.08)" },
        yaxis: { title: { text: "隔日 HRV (ms)", font: { size: 11 } },
                 gridcolor: "rgba(127,127,127,0.08)" },
        height: 320, showlegend: false,
      }, { displaylogo: false, responsive: true });
    }
  }
}
export function renderTask4(frame, container) {
  container.innerHTML = PENDING_NOTE(4, "🚶 任務 4：步態力學");
}
export function renderTask5(frame, container) {
  container.innerHTML = PENDING_NOTE(5, "🌅 任務 5：環境與生理節律");
}
export function renderTask6(frame, container) {
  container.innerHTML = PENDING_NOTE(6, "✅ 任務 6：Readiness Score");
}
export function renderTask7(frame, container) {
  container.innerHTML = PENDING_NOTE(7, "🤒 任務 7：生病早警");
}
