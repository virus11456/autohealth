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
  // Wrap in scroll-x so wide tables don't blow out the viewport on mobile.
  return `<div class="scroll-x"><table class="task-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
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

// Metric card with embedded sparkline.
//
// Baseline + z-score resolution order (most accurate → fallback):
//   1. Pre-computed `${baselineKey}_baseline30` / `_zscore30` from frame rows
//      (computed by aggregator with min_periods=7 over the FULL frame, so
//      survives sparse data and date filtering)
//   2. Rolling mean over the passed-in (already date-filtered) raw array
//   3. Overall mean / std over the passed-in raw array (last resort —
//      labelled differently in the UI)
function metricCard({ chartId, label, unit, dates, raw, smooth, frameRows, baselineKey,
                     higherIsBetter = true, hint = "" }) {
  const i = lastFiniteIdx(raw);
  const value = i >= 0 ? raw[i] : NaN;

  // Try pre-computed columns first
  let baseline = NaN, z = NaN, mode = "none";
  if (frameRows && baselineKey && i >= 0) {
    const row = frameRows[i];
    const preBaseline = row?.[`${baselineKey}_baseline30`];
    const preZ = row?.[`${baselineKey}_zscore30`];
    if (Number.isFinite(preBaseline)) { baseline = preBaseline; mode = "rolling30"; }
    if (Number.isFinite(preZ)) z = preZ;
  }
  // Fallback to rolling mean from smooth array
  if (!Number.isFinite(baseline) && i >= 0 && Number.isFinite(smooth[i])) {
    baseline = smooth[i]; mode = "rolling30";
  }
  // Last resort: overall mean across the visible window
  if (!Number.isFinite(baseline)) {
    const m = meanFinite(raw);
    if (Number.isFinite(m)) { baseline = m; mode = "overall"; }
  }
  // Compute z if no pre-computed value
  if (!Number.isFinite(z) && Number.isFinite(value) && Number.isFinite(baseline)) {
    const std = stdFinite(raw);
    if (Number.isFinite(std) && std > 0) z = (value - baseline) / std;
  }

  const status = statusFromZ(z, higherIsBetter);
  const delta = (Number.isFinite(value) && Number.isFinite(baseline)) ? value - baseline : NaN;
  const deltaSign = (higherIsBetter ? delta : -delta) >= 0 ? "good" : "bad";
  const deltaClass = Number.isFinite(delta) ? deltaSign : "muted";
  const fmtV = (v) => !Number.isFinite(v) ? "—" :
    Math.abs(v) >= 100 ? v.toFixed(0) :
    Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  const baselineLabel = mode === "rolling30" ? "30 天基線" :
                        mode === "overall"   ? "整體平均（資料稀疏，無 30 天 baseline）" :
                                               "資料不足";
  const zText = Number.isFinite(z) ? `（${z >= 0 ? "+" : ""}${z.toFixed(2)}σ）` : "";
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
          ${Number.isFinite(delta) ? (delta >= 0 ? "↑ +" : "↓ ") + fmtV(Math.abs(delta)) + unit : ""}
        </span>
        <span class="muted">vs ${baselineLabel} ${fmtV(baseline)}${unit} ${zText}</span>
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
  let html = '<div class="scroll-x"><table class="task-table"><thead><tr><th></th>';
  for (const l of labels) html += `<th class="num">${l}</th>`;
  html += "</tr></thead><tbody>";
  for (let i = 0; i < n; i++) {
    html += `<tr><th>${labels[i]}</th>`;
    for (let j = 0; j < n; j++) {
      const cell = m[i][j];
      const r = cell.r;
      let text;
      if (i === j) text = "—";
      else if (Number.isFinite(r)) {
        text = `<span style="color:${corrCellColor(r)}">${r >= 0 ? "+" : ""}${r.toFixed(2)}</span>` +
               `<br><span class="muted" style="font-size:0.7rem">n=${cell.n}</span>`;
      } else {
        text = `—<br><span class="muted" style="font-size:0.7rem">n=${cell.n ?? 0}</span>`;
      }
      html += `<td class="num">${text}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table></div>";
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
    frameRows: frame.rows, baselineKey: "hrv",
    hint: "心率變異 ↑ = 自律神經彈性好",
  });
  html += metricCard({
    chartId: "t2-chart-rhr", label: "靜息心率", unit: " bpm",
    dates, raw: rhr, smooth: rhrSm, higherIsBetter: false,
    frameRows: frame.rows, baselineKey: "resting_hr",
    hint: "靜息心率 ↓ = 心肺基底進步",
  });
  html += metricCard({
    chartId: "t2-chart-walking", label: "步行心率", unit: " bpm",
    dates, raw: walking, smooth: walkingSm, higherIsBetter: false,
    frameRows: frame.rows, baselineKey: "walking_hr",
    hint: "同強度步行心率 ↓ = 心肺效率提升",
  });
  html += `</div>`;

  // Correlation matrix on RAW values (Spearman is rank-based; z-score
  // standardisation is a monotonic transform and produces identical ranks,
  // so using raw values is mathematically equivalent but covers many more
  // days when z-score columns are sparse — a real concern with light wearers).
  html += `<h3>🔗 三角相關矩陣 (Spearman)</h3>`;
  html += `<p class="muted" style="margin: 0 0 8px 0;">用每日數值算 Spearman 排序相關（對非線性 / 離群值穩健）。藍 = 正相關，紅 = 負相關。健康狀況下：HRV ↔ RHR 應該是負，HRV ↔ 步行 HR 應該是負，RHR ↔ 步行 HR 應該是正。</p>`;
  html += corrMatrixHtml(["HRV", "靜息 HR", "步行 HR"], [hrv, rhr, walking]);

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
  let mtxHtml = `<div class="scroll-x"><table class="task-table"><thead><tr><th>　</th>`;
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
  mtxHtml += `</tbody></table></div>`;
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
  if (!frame || frame.rows.length < 14) {
    container.innerHTML = `<h2 class="task-title">🚶 任務 4：步態力學</h2>` +
      emptyState("資料量太少，至少需要 14 天。");
    return;
  }

  // walking_speed_mps / step_length_cm / walking_hr only show up on iPhone 14+
  // and require some accumulated walking — we list them up-front as required so
  // people on older phones see why the tab is empty.
  const required = ["walking_asymmetry", "double_support",
                    "walking_speed_mps", "step_length_cm",
                    "walking_hr", "steps"];
  const missing = required.filter((c) => !frame.columns.includes(c) ||
    !columnValues(frame, c).some(Number.isFinite));
  if (missing.length) {
    container.innerHTML = `<h2 class="task-title">🚶 任務 4：步態力學</h2>` +
      callout("warn", `<strong>⚠ 缺少指標：</strong>${missing.map(labelOf).join(" / ")}<br>` +
        `步行速度 / 步長 / 步行心率 / 不對稱率 / 雙腳支撐都需要 iPhone 較長使用時間 + 規律走路才會穩定累積。`);
    return;
  }

  const dates = frame.rows.map((r) => r.date);
  const asym = columnValues(frame, "walking_asymmetry");
  const ds = columnValues(frame, "double_support");
  const ws = columnValues(frame, "walking_speed_mps");
  const sl = columnValues(frame, "step_length_cm");
  const wh = columnValues(frame, "walking_hr");
  const steps = columnValues(frame, "steps");

  // gait_efficiency: scaled to m / beat so the number is human-readable
  // (raw m/s / bpm gives values like 0.013 which is hard to feel).
  const eff = ws.map((s, i) => Number.isFinite(s) && Number.isFinite(wh[i]) && wh[i] > 0
    ? (s * 60) / wh[i] : NaN);
  const asymSm = rollingMean(asym, 30);
  const dsSm = rollingMean(ds, 30);
  const wsSm = rollingMean(ws, 30);
  const slSm = rollingMean(sl, 30);
  const effSm = rollingMean(eff, 30);

  // Anomaly weeks
  const weekMap = groupByWeek(frame.rows);
  const asymBaseline = meanFinite(asym);
  const asymStd = stdFinite(asym);
  const asymThreshold = asymBaseline + 1.5 * asymStd;
  const stepsBaseline = meanFinite(steps);
  const anomWeeks = [];
  for (const [weekKey, rows] of weekMap) {
    const wAsym = meanFinite(rows.map((r) => r.walking_asymmetry));
    const wDs = meanFinite(rows.map((r) => r.double_support));
    const wSteps = meanFinite(rows.map((r) => r.steps));
    const triggers = [];
    if (Number.isFinite(wAsym) && wAsym > asymThreshold) triggers.push("不對稱率 ↑");
    if (Number.isFinite(wDs) && wDs > 30) triggers.push("雙腳支撐 > 30%");
    if (!triggers.length) continue;
    anomWeeks.push({
      weekKey, wAsym, wDs, wSteps,
      triggers: triggers.join(" + "),
      stepsHigh: Number.isFinite(wSteps) && Number.isFinite(stepsBaseline) && wSteps > stepsBaseline * 1.2,
    });
  }
  anomWeeks.sort((a, b) => b.weekKey.localeCompare(a.weekKey));

  // Top 10% vs bottom 10% step days
  const validIdx = [];
  for (let i = 0; i < frame.rows.length; i++) {
    if (Number.isFinite(steps[i])) validIdx.push(i);
  }
  validIdx.sort((a, b) => steps[a] - steps[b]);
  const n = validIdx.length;
  const lowIdx = validIdx.slice(0, Math.max(1, Math.floor(n * 0.1)));
  const highIdx = validIdx.slice(Math.ceil(n * 0.9));
  const compareMetrics = [
    { key: "walking_asymmetry", label: "步行不對稱率", arr: asym, higherBetter: false, unit: "%" },
    { key: "double_support",    label: "雙腳支撐",     arr: ds,   higherBetter: false, unit: "%" },
    { key: "walking_speed_mps", label: "步行速度",     arr: ws,   higherBetter: true,  unit: " m/s" },
    { key: "step_length_cm",    label: "步長",         arr: sl,   higherBetter: true,  unit: " cm" },
  ];
  const compareRows = compareMetrics.map((m) => {
    const lowVals = lowIdx.map((i) => m.arr[i]).filter(Number.isFinite);
    const highVals = highIdx.map((i) => m.arr[i]).filter(Number.isFinite);
    return { ...m,
      lowMean: lowVals.length ? meanFinite(lowVals) : NaN,
      highMean: highVals.length ? meanFinite(highVals) : NaN,
      t: lowVals.length >= 5 && highVals.length >= 5 ? welchTTest(highVals, lowVals)
                                                     : { t: NaN, p: NaN, na: highVals.length, nb: lowVals.length },
    };
  });

  // ---- Render ----
  let html = `<h2 class="task-title">🚶 任務 4：步態力學</h2>`;
  html += `<p class="task-intro">不對稱率 / 雙腳支撐 / 步速 / 步長 + 步態效率。Apple 比較少人看的數據，但對「身體有沒有偷偷在代償」很敏感——舊傷、髖緊、長短腳常先在這裡發出訊號。</p>`;

  // 5 metric cards (4 raw + 1 derived efficiency)
  html += `<h3>📏 4 個步態指標 + 步態效率</h3>`;
  html += `<div class="metric-grid">`;
  html += metricCard({
    chartId: "t4-asym", label: "步行不對稱率", unit: " %",
    dates, raw: asym, smooth: asymSm, higherIsBetter: false,
    frameRows: frame.rows,
    hint: ">3% 通常代表單側代償（舊傷 / 髖緊 / 長短腳）",
  });
  html += metricCard({
    chartId: "t4-ds", label: "雙腳支撐時間", unit: " %",
    dates, raw: ds, smooth: dsSm, higherIsBetter: false,
    frameRows: frame.rows,
    hint: ">30% = 步態保守、平衡信心低",
  });
  html += metricCard({
    chartId: "t4-ws", label: "步行速度", unit: " m/s",
    dates, raw: ws, smooth: wsSm, higherIsBetter: true,
    frameRows: frame.rows,
    hint: "速度 ↓ = 整體步態效率退步的早期訊號",
  });
  html += metricCard({
    chartId: "t4-sl", label: "步長", unit: " cm",
    dates, raw: sl, smooth: slSm, higherIsBetter: true,
    frameRows: frame.rows,
    hint: "步長 ↓ + 速度 ↓ = 退化或疲勞",
  });
  html += metricCard({
    chartId: "t4-eff", label: "步態效率", unit: " m/beat",
    dates, raw: eff, smooth: effSm, higherIsBetter: true,
    frameRows: frame.rows,
    hint: "= 速度 × 60 / 步行心率　·　每心跳走多遠，越大越省力",
  });
  html += `</div>`;

  // Anomaly weeks
  html += `<h3>⚠ 步態異常週</h3>`;
  html += `<p class="muted">週均「不對稱率」&gt; 個人基線 + 1.5σ（= ${Number.isFinite(asymThreshold) ? asymThreshold.toFixed(1) + "%" : "—"}），或 週均「雙腳支撐」&gt; 30%。同時看當週步數，判斷是否伴隨高量訓練。</p>`;
  if (!anomWeeks.length) {
    html += `<p class="muted">沒有偵測到符合條件的異常週。</p>`;
  } else {
    const rows = anomWeeks.slice(0, 30).map((w) => [
      w.weekKey + " 起",
      Number.isFinite(w.wAsym) ? w.wAsym.toFixed(2) + "%" : "—",
      Number.isFinite(w.wDs) ? w.wDs.toFixed(1) + "%" : "—",
      (Number.isFinite(w.wSteps) ? Math.round(w.wSteps).toLocaleString() : "—") +
        (w.stepsHigh ? ` <span style="color:var(--warn)">(高量)</span>` : ""),
      w.triggers,
    ]);
    html += tableHtml(["週", "不對稱率", "雙腳支撐", "週均步數", "觸發條件"], rows, { numCols: [1, 2, 3] });
    if (anomWeeks.length > 30) html += `<p class="muted">（顯示前 30 筆，共 ${anomWeeks.length} 筆）</p>`;
  }

  // High vs low step day comparison
  html += `<h3>📊 高步數日 vs 低步數日：步態指標差異</h3>`;
  html += `<p class="muted">把資料期間「步數 top 10%」(n = ${highIdx.length}) 跟「bottom 10%」(n = ${lowIdx.length}) 對比。Welch t-test, p &lt; 0.05 = 統計顯著（標 *）。</p>`;
  if (lowIdx.length < 5 || highIdx.length < 5) {
    html += `<p class="muted">每組樣本太少（&lt; 5 天），無法做 t-test。</p>`;
  } else {
    const cmpRows = compareRows.map((r) => {
      const dirSign = r.highMean - r.lowMean;
      const goodSign = r.higherBetter ? dirSign > 0 : dirSign < 0;
      const dirText = (dirSign >= 0 ? "↑ +" : "↓ ") + Math.abs(dirSign).toFixed(2) + r.unit;
      const sigStar = Number.isFinite(r.t.p) && r.t.p < 0.05 ? " *" : "";
      const pText = Number.isFinite(r.t.p) ? r.t.p.toFixed(3) : "—";
      return [
        r.label,
        Number.isFinite(r.lowMean) ? r.lowMean.toFixed(2) + r.unit : "—",
        Number.isFinite(r.highMean) ? r.highMean.toFixed(2) + r.unit : "—",
        `<span style="color:${goodSign ? 'var(--good)' : 'var(--bad)'}">${dirText}</span>`,
        pText + sigStar,
      ];
    });
    html += tableHtml(["指標", "低步數日均", "高步數日均", "高 vs 低 (差)", "p 值"], cmpRows,
      { numCols: [1, 2, 3, 4] });
    // Plain-language summary
    const sigBad = compareRows.filter((r) => Number.isFinite(r.t.p) && r.t.p < 0.05 &&
      ((r.higherBetter && r.highMean < r.lowMean) || (!r.higherBetter && r.highMean > r.lowMean)));
    if (sigBad.length) {
      html += callout("warn",
        `<strong>觀察</strong>　高步數日 ${sigBad.map((m) => m.label).join(" / ")} 顯著惡化 — 你的身體在大量行走時可能在累積代償，建議高量訓練後安排恢復日。`);
    } else {
      html += callout("good",
        `<strong>觀察</strong>　高步數日步態指標沒有顯著惡化，代表你目前承受得住目前訓練量。`);
    }
  }

  container.innerHTML = html;

  // Mini charts
  drawMetricChart("t4-asym", dates, asym, asymSm, "#f0a020");
  drawMetricChart("t4-ds", dates, ds, dsSm, "#f0a020");
  drawMetricChart("t4-ws", dates, ws, wsSm, "#34c38f");
  drawMetricChart("t4-sl", dates, sl, slSm, "#34c38f");
  drawMetricChart("t4-eff", dates, eff, effSm, "#4f8cff");
}
export function renderTask5(frame, container) {
  if (!frame || frame.rows.length < 14) {
    container.innerHTML = `<h2 class="task-title">🌅 任務 5：環境與生理節律</h2>` +
      emptyState("資料量太少。");
    return;
  }
  const required = ["daylight", "sleep_score", "bedtime_hour", "hrv"];
  const missing = required.filter((c) => !frame.columns.includes(c) ||
    !columnValues(frame, c).some(Number.isFinite));
  if (missing.length) {
    container.innerHTML = `<h2 class="task-title">🌅 任務 5：環境與生理節律</h2>` +
      callout("warn", `<strong>⚠ 缺少指標：</strong>${missing.map(labelOf).join(" / ")}<br>` +
        `日照需要 watchOS 10+；上床時間需要設定睡眠排程。`);
    return;
  }

  const dates = frame.rows.map((r) => r.date);
  const daylight = columnValues(frame, "daylight");
  const sleepScore = columnValues(frame, "sleep_score");
  const bedtime = columnValues(frame, "bedtime_hour");
  const hrv = columnValues(frame, "hrv");

  // Derive is_weekend from the row date — Apple Health export doesn't carry this
  const isWeekend = frame.rows.map((r) => {
    const day = new Date(r.date + "T00:00:00").getDay();
    return day === 0 || day === 6;
  });

  const daylightSm = rollingMean(daylight, 30);
  const sleepScoreSm = rollingMean(sleepScore, 30);
  const bedtimeSm = rollingMean(bedtime, 30);

  // Monthly std of bedtime_hour — circadian stability proxy
  const monthMap = groupByMonth(frame.rows);
  const monthlyStd = [];
  for (const [monthKey, rows] of monthMap) {
    const beds = rows.map((r) => r.bedtime_hour).filter(Number.isFinite);
    if (beds.length < 5) continue;
    monthlyStd.push({ month: monthKey, std: stdFinite(beds), n: beds.length });
  }
  monthlyStd.sort((a, b) => a.month.localeCompare(b.month));
  const latestStd = monthlyStd.length ? monthlyStd[monthlyStd.length - 1] : null;
  const overallBedStd = stdFinite(bedtime);

  // Daylight bins → that night's sleep_score (the brief's binning thresholds)
  const daylightBins = [
    { label: "<30 分", lo: -Infinity, hi: 30, color: "#ef4444", scores: [] },
    { label: "30-60 分", lo: 30, hi: 60, color: "#f0a020", scores: [] },
    { label: "60-120 分", lo: 60, hi: 120, color: "#4f8cff", scores: [] },
    { label: ">120 分", lo: 120, hi: Infinity, color: "#34c38f", scores: [] },
  ];
  for (let i = 0; i < frame.rows.length; i++) {
    const dl = daylight[i], sc = sleepScore[i];
    if (!Number.isFinite(dl) || !Number.isFinite(sc)) continue;
    for (const b of daylightBins) {
      if (dl >= b.lo && dl < b.hi) { b.scores.push(sc); break; }
    }
  }

  // Daylight deficit: find ≥3-day runs of daylight < 30, then collect HRV
  // values in the 7 days after each run ends. Compare to all other days.
  const postDeficit = new Set();
  let runStart = -1;
  for (let i = 0; i < frame.rows.length; i++) {
    if (Number.isFinite(daylight[i]) && daylight[i] < 30) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0 && i - runStart >= 3) {
        for (let j = i; j < Math.min(frame.rows.length, i + 7); j++) postDeficit.add(j);
      }
      runStart = -1;
    }
  }
  const deficitHrv = [], otherHrv = [];
  for (let i = 0; i < frame.rows.length; i++) {
    if (!Number.isFinite(hrv[i])) continue;
    (postDeficit.has(i) ? deficitHrv : otherHrv).push(hrv[i]);
  }
  const deficitT = (deficitHrv.length >= 5 && otherHrv.length >= 5)
    ? welchTTest(deficitHrv, otherHrv) : null;

  // Weekend vs weekday t-test across many metrics
  const compareKeys = [
    { key: "hrv",          label: "HRV",         higherBetter: true,  unit: " ms" },
    { key: "resting_hr",   label: "靜息心率",   higherBetter: false, unit: " bpm" },
    { key: "sleep_score",  label: "睡眠分數",   higherBetter: true,  unit: " /100" },
    { key: "sleep_hours",  label: "睡眠時數",   higherBetter: true,  unit: " h" },
    { key: "steps",        label: "步數",       higherBetter: true,  unit: "" },
    { key: "bedtime_hour", label: "上床時間",   higherBetter: false, unit: " h" },
    { key: "daylight",     label: "日照",       higherBetter: true,  unit: " 分" },
  ].filter((m) => frame.columns.includes(m.key));
  const wkRows = compareKeys.map((m) => {
    const arr = columnValues(frame, m.key);
    const wknd = [], wkdy = [];
    for (let i = 0; i < frame.rows.length; i++) {
      if (!Number.isFinite(arr[i])) continue;
      (isWeekend[i] ? wknd : wkdy).push(arr[i]);
    }
    return { ...m,
      wkdyMean: wkdy.length ? meanFinite(wkdy) : NaN,
      wkndMean: wknd.length ? meanFinite(wknd) : NaN,
      t: (wknd.length >= 5 && wkdy.length >= 5) ? welchTTest(wknd, wkdy)
                                                : { t: NaN, p: NaN, na: wknd.length, nb: wkdy.length },
    };
  });

  // ---- Render ----
  let html = `<h2 class="task-title">🌅 任務 5：環境與生理節律</h2>`;
  html += `<p class="task-intro">日照是調節晝夜節律最強的因子；上床時間穩定性會反映在 HRV 與深睡比上。常出國（時區跳動）這個分頁特別有用。</p>`;

  // Top cards
  html += `<h3>📊 環境 + 節律核心指標</h3>`;
  html += `<div class="metric-grid">`;
  html += metricCard({
    chartId: "t5-daylight", label: "日照時間", unit: " 分",
    dates, raw: daylight, smooth: daylightSm, higherIsBetter: true,
    frameRows: frame.rows, baselineKey: "daylight",
    hint: "&lt; 30 分連 ≥ 3 天 → 容易影響晝夜節律 + 深睡比",
  });
  html += metricCard({
    chartId: "t5-bedtime", label: "上床時間", unit: " h",
    dates, raw: bedtime, smooth: bedtimeSm, higherIsBetter: false,
    frameRows: frame.rows,
    hint: "23 = 23:00, 25 = 隔日 01:00。越早越好",
  });
  html += metricCard({
    chartId: "t5-sleep", label: "睡眠分數", unit: " /100",
    dates, raw: sleepScore, smooth: sleepScoreSm, higherIsBetter: true,
    frameRows: frame.rows, baselineKey: "sleep_score",
    hint: "日照充足通常會推升深睡比 → 睡眠分數提升",
  });
  // Stability stat card (no sparkline; uses statCard)
  const stabStatus = latestStd ? (
    latestStd.std < 0.5 ? { emoji: "🟢", label: "穩定", cls: "good" } :
    latestStd.std < 1.0 ? { emoji: "🔵", label: "尚可", cls: "fair" } :
    latestStd.std < 1.5 ? { emoji: "🟡", label: "略不穩", cls: "low" } :
    { emoji: "🔴", label: "作息混亂", cls: "alert" }
  ) : { emoji: "⚪", label: "資料不足", cls: "empty" };
  html += statCard({
    label: "作息穩定度（最近月）",
    value: latestStd ? `±${latestStd.std.toFixed(2)} h` : "—",
    subtitle: latestStd
      ? `${latestStd.month}　·　n = ${latestStd.n}　·　整體 ±${Number.isFinite(overallBedStd) ? overallBedStd.toFixed(2) : "—"} h`
      : `整體 ±${Number.isFinite(overallBedStd) ? overallBedStd.toFixed(2) : "—"} h`,
    status: stabStatus,
    hint: "上床時間的月度標準差 — 越小代表你睡眠時點越固定",
  });
  html += `</div>`;

  // Daylight bin
  html += `<h3>☀ 日照時間 → 當晚睡眠分數分佈</h3>`;
  html += `<p class="muted">把每日日照時間分 4 箱，看當晚睡眠分數的分佈。理想：日照越多，睡眠分數中位數越高。</p>`;
  html += tableHtml(["日照區間", "天數", "睡眠分數平均"],
    daylightBins.map((b) => [b.label, b.scores.length,
      b.scores.length ? meanFinite(b.scores).toFixed(1) : "—"]),
    { numCols: [1, 2] });
  html += `<div id="t5-bin" class="task-chart"></div>`;

  // Monthly bedtime std
  html += `<h3>📈 月度作息穩定度</h3>`;
  if (monthlyStd.length < 2) {
    html += `<p class="muted">資料還不到 2 個月，無法畫月度趨勢。</p>`;
  } else {
    html += `<p class="muted">每月上床時間的標準差。&lt; 0.5 h = 作息相當固定；&gt; 1.5 h = 上床時間天天不同。</p>`;
    html += `<div id="t5-stab" class="task-chart"></div>`;
  }

  // Daylight deficit t-test
  html += `<h3>🌧 日照不足連 3 天後 HRV 影響</h3>`;
  if (!deficitT) {
    html += `<p class="muted">資料中沒有「日照 &lt; 30 分」連續 3 天以上的時段，或樣本太少無法做 t-test。</p>`;
  } else {
    const dropMs = deficitT.ma - deficitT.mb;
    const isSig = Number.isFinite(deficitT.p) && deficitT.p < 0.05;
    const sigClass = isSig ? (dropMs < 0 ? "alert" : "info") : "info";
    html += callout(sigClass,
      `<strong>${isSig ? (dropMs < 0 ? "⚠ HRV 顯著下降" : "ℹ 有顯著差異（往上）") : "ℹ 沒有顯著影響"}</strong><br>` +
      `日照不足後 7 天 HRV 平均：<strong>${deficitT.ma.toFixed(1)} ms</strong> (n = ${deficitT.na})<br>` +
      `其他時段 HRV 平均：<strong>${deficitT.mb.toFixed(1)} ms</strong> (n = ${deficitT.nb})<br>` +
      `差異 ${(dropMs >= 0 ? "+" : "") + dropMs.toFixed(1)} ms　·　Welch t = ${deficitT.t.toFixed(2)}, p = ${Number.isFinite(deficitT.p) ? deficitT.p.toFixed(3) : "—"}${isSig ? " *" : ""}`);
  }

  // Weekend vs weekday
  html += `<h3>📅 假日 vs 平日全指標差異</h3>`;
  html += `<p class="muted">看「週末恢復效應」是否真的存在。Welch t-test，p &lt; 0.05 = 有顯著差異（標 *）。</p>`;
  const wkTableRows = wkRows.map((r) => {
    const diff = r.wkndMean - r.wkdyMean;
    const goodSign = Number.isFinite(diff) && (r.higherBetter ? diff > 0 : diff < 0);
    const sigStar = Number.isFinite(r.t.p) && r.t.p < 0.05 ? " *" : "";
    const dirText = Number.isFinite(diff) ? (diff >= 0 ? "+" : "") + diff.toFixed(2) + r.unit : "—";
    return [
      r.label,
      Number.isFinite(r.wkdyMean) ? r.wkdyMean.toFixed(2) + r.unit : "—",
      Number.isFinite(r.wkndMean) ? r.wkndMean.toFixed(2) + r.unit : "—",
      `<span style="color:${goodSign ? 'var(--good)' : 'var(--bad)'}">${dirText}</span>`,
      Number.isFinite(r.t.p) ? r.t.p.toFixed(3) + sigStar : "—",
    ];
  });
  html += tableHtml(["指標", "平日均", "週末均", "週末 vs 平日 (差)", "p 值"], wkTableRows,
    { numCols: [1, 2, 3, 4] });

  container.innerHTML = html;

  // Mini metric charts
  drawMetricChart("t5-daylight", dates, daylight, daylightSm, "#f0a020");
  drawMetricChart("t5-bedtime", dates, bedtime, bedtimeSm, "#a78bfa");
  drawMetricChart("t5-sleep", dates, sleepScore, sleepScoreSm, "#34c38f");

  if (typeof Plotly !== "undefined") {
    const binDiv = document.getElementById("t5-bin");
    if (binDiv) {
      const traces = daylightBins.filter((b) => b.scores.length).map((b) => ({
        type: "box", y: b.scores, name: b.label,
        marker: { color: b.color }, line: { color: b.color },
        boxpoints: "outliers", boxmean: true,
      }));
      Plotly.newPlot(binDiv, traces, {
        paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
        font: { color: "#e6e9ef", family: "inherit", size: 11 },
        margin: { l: 50, r: 20, t: 20, b: 40 },
        xaxis: { title: { text: "日照區間", font: { size: 11 } }, gridcolor: "rgba(127,127,127,0.08)" },
        yaxis: { title: { text: "當晚睡眠分數", font: { size: 11 } }, gridcolor: "rgba(127,127,127,0.08)" },
        height: 280, showlegend: false,
      }, { displaylogo: false, responsive: true });
    }
    if (monthlyStd.length >= 2) {
      const stabDiv = document.getElementById("t5-stab");
      if (stabDiv) {
        Plotly.newPlot(stabDiv, [{
          x: monthlyStd.map((m) => m.month),
          y: monthlyStd.map((m) => m.std),
          type: "bar",
          marker: { color: monthlyStd.map((m) =>
            m.std < 0.5 ? "#34c38f" :
            m.std < 1.0 ? "#4f8cff" :
            m.std < 1.5 ? "#f0a020" : "#ef4444"),
          },
        }], {
          paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
          font: { color: "#e6e9ef", family: "inherit", size: 11 },
          margin: { l: 50, r: 20, t: 20, b: 40 },
          xaxis: { gridcolor: "rgba(127,127,127,0.08)" },
          yaxis: { title: { text: "上床時間 std (h)", font: { size: 11 } },
                   gridcolor: "rgba(127,127,127,0.08)" },
          height: 240, showlegend: false,
        }, { displaylogo: false, responsive: true });
      }
    }
  }
}
// Spec'd readiness components (per the analytical brief). Each component is a
// scaled z-score-equivalent in roughly [-2, +2]; the final aggregation is
//   50 + 12.5 * Σ(w_i * c_i) / Σ w_i (over available components)
// which keeps the score on a 0-100 axis even when some components are missing.
function readinessComponents(row) {
  const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const out = {};
  if (Number.isFinite(row.hrv_zscore30)) out.hrv = clip(row.hrv_zscore30, -2, 2);
  if (Number.isFinite(row.resting_hr_zscore30)) out.rhr = clip(-row.resting_hr_zscore30, -2, 2);
  if (Number.isFinite(row.sleep_score)) out.sleep = (row.sleep_score - 70) / 15;
  if (Number.isFinite(row.respiratory_zscore30)) out.resp = clip(-row.respiratory_zscore30, -2, 2);
  if (Number.isFinite(row.wrist_temp_delta_c_zscore30)) out.temp = clip(-Math.abs(row.wrist_temp_delta_c_zscore30), -2, 0);
  return out;
}

const READINESS_WEIGHTS = {
  spec:        { hrv: 0.30, rhr: 0.25, sleep: 0.25, resp: 0.10, temp: 0.10, label: "Brief 規格" },
  hrvHeavy:    { hrv: 0.40, rhr: 0.20, sleep: 0.20, resp: 0.10, temp: 0.10, label: "HRV 加重" },
  sleepHeavy:  { hrv: 0.20, rhr: 0.20, sleep: 0.35, resp: 0.15, temp: 0.10, label: "睡眠加重" },
  equal:       { hrv: 0.20, rhr: 0.20, sleep: 0.20, resp: 0.20, temp: 0.20, label: "等權" },
};

function aggregateReadiness(components, weights) {
  let weighted = 0, weightSum = 0;
  for (const k of ["hrv", "rhr", "sleep", "resp", "temp"]) {
    if (k in components) {
      weighted += weights[k] * components[k];
      weightSum += weights[k];
    }
  }
  if (weightSum === 0) return NaN;
  // Renormalize so partial-coverage days still produce comparable scores
  const normalizedSum = weighted / weightSum;
  return Math.max(0, Math.min(100, 50 + 12.5 * normalizedSum));
}

function readinessClassFromValue(v) {
  if (!Number.isFinite(v)) return { emoji: "⚪", label: "資料不足", cls: "empty", color: "var(--muted)" };
  if (v >= 75) return { emoji: "🟢", label: "綠燈", cls: "good", color: "var(--good)" };
  if (v >= 60) return { emoji: "🔵", label: "尚可", cls: "fair", color: "var(--info)" };
  if (v >= 40) return { emoji: "🟡", label: "偏低", cls: "low", color: "var(--warn)" };
  return { emoji: "🔴", label: "紅燈", cls: "alert", color: "var(--bad)" };
}

const COMPONENT_LABEL = {
  hrv:   "HRV",
  rhr:   "靜息心率",
  sleep: "睡眠分數",
  resp:  "呼吸頻率穩定",
  temp:  "手腕體溫穩定",
};

export function renderTask6(frame, container) {
  if (!frame || frame.rows.length < 14) {
    container.innerHTML = `<h2 class="task-title">✅ 任務 6：Readiness Score</h2>` +
      emptyState("資料量太少，至少需要 14 天 + 30 天 baseline 才能算公式。");
    return;
  }

  // Compute readiness for every row (with all 4 weight schemes ready for sensitivity)
  const readiness = frame.rows.map((row) => {
    const c = readinessComponents(row);
    return {
      components: c,
      spec:       aggregateReadiness(c, READINESS_WEIGHTS.spec),
      hrvHeavy:   aggregateReadiness(c, READINESS_WEIGHTS.hrvHeavy),
      sleepHeavy: aggregateReadiness(c, READINESS_WEIGHTS.sleepHeavy),
      equal:      aggregateReadiness(c, READINESS_WEIGHTS.equal),
    };
  });

  // Pick today's row (latest with finite spec readiness)
  let todayIdx = -1;
  for (let i = readiness.length - 1; i >= 0; i--) {
    if (Number.isFinite(readiness[i].spec)) { todayIdx = i; break; }
  }
  if (todayIdx < 0) {
    container.innerHTML = `<h2 class="task-title">✅ 任務 6：Readiness Score</h2>` +
      callout("warn", `<strong>⚠ 沒有可算分數的天</strong>　大概是 30 天 baseline 還沒成形（HRV / 靜息心率 / 睡眠分數 / 呼吸頻率 任一個的 z-score 都還沒有資料）。`);
    return;
  }
  const today = readiness[todayIdx];
  const todayDate = frame.rows[todayIdx].date;
  const todayClass = readinessClassFromValue(today.spec);
  const todayComponentCount = Object.keys(today.components).length;

  // Recent 7-day mean / prior 21-day mean (using spec weights)
  const specSeries = readiness.map((r) => r.spec);
  const finiteIdx = [];
  for (let i = 0; i < specSeries.length; i++) if (Number.isFinite(specSeries[i])) finiteIdx.push(i);
  const last7 = finiteIdx.slice(-7).map((i) => specSeries[i]);
  const prior21 = finiteIdx.slice(-28, -7).map((i) => specSeries[i]);
  const recent7Mean = last7.length ? meanFinite(last7) : NaN;
  const prior21Mean = prior21.length >= 5 ? meanFinite(prior21) : NaN;
  const trend = (Number.isFinite(recent7Mean) && Number.isFinite(prior21Mean))
    ? recent7Mean - prior21Mean : NaN;

  // Dominant driver today: which component is pulling spec score the most
  // (positive contribution = pushes up; negative = pulls down)
  const todayContribs = [];
  for (const k of ["hrv", "rhr", "sleep", "resp", "temp"]) {
    if (k in today.components) {
      todayContribs.push({
        key: k, label: COMPONENT_LABEL[k],
        value: today.components[k],
        contribution: READINESS_WEIGHTS.spec[k] * today.components[k],
      });
    }
  }
  todayContribs.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const driver = todayContribs[0];

  // Day classification counts (over all finite readiness days)
  const greens = finiteIdx.filter((i) => specSeries[i] >= 75);
  const reds = finiteIdx.filter((i) => specSeries[i] < 40);

  // Sensitivity comparison table
  const sensRows = ["spec", "hrvHeavy", "sleepHeavy", "equal"].map((k) => {
    const w = READINESS_WEIGHTS[k];
    const v = today[k];
    return [
      w.label,
      `${(w.hrv * 100).toFixed(0)} / ${(w.rhr * 100).toFixed(0)} / ${(w.sleep * 100).toFixed(0)} / ${(w.resp * 100).toFixed(0)} / ${(w.temp * 100).toFixed(0)}`,
      Number.isFinite(v) ? v.toFixed(1) : "—",
      readinessClassFromValue(v).label,
    ];
  });

  // ---- Render ----
  let html = `<h2 class="task-title">✅ 任務 6：自製 Readiness Score</h2>`;
  html += `<p class="task-intro">把 HRV / 靜息心率 / 睡眠分數 / 呼吸頻率 / 手腕體溫的 z-score 整合成 0-100 的每日恢復分數。指導「今天該不該硬操、該不該做重要決策」。</p>`;

  // Hero today's score
  html += `<div class="readiness-hero status-${todayClass.cls}">
    <div class="readiness-date muted">${todayDate}</div>
    <div class="readiness-value" style="color:${todayClass.color}">${Number.isFinite(today.spec) ? today.spec.toFixed(0) : "—"}<span class="readiness-scale"> / 100</span></div>
    <div class="readiness-band" style="color:${todayClass.color}">${todayClass.emoji} ${todayClass.label}</div>
    <div class="readiness-trend muted">
      近 7 天均：<strong>${Number.isFinite(recent7Mean) ? recent7Mean.toFixed(1) : "—"}</strong>　·
      前 21 天均：<strong>${Number.isFinite(prior21Mean) ? prior21Mean.toFixed(1) : "—"}</strong>　·
      ${Number.isFinite(trend) ? `趨勢：<span style="color:${trend > 0 ? "var(--good)" : trend < 0 ? "var(--bad)" : "var(--muted)"}"><strong>${trend >= 0 ? "+" : ""}${trend.toFixed(1)}</strong></span>` : ""}
    </div>
  </div>`;

  // Warn if too few components — 1-2 components means the score is largely
  // driven by a single dimension and won't be representative of overall recovery.
  if (todayComponentCount < 3) {
    html += callout("warn",
      `<strong>⚠ 今日只有 ${todayComponentCount} 個組成成分有資料</strong>　（共 5 個：HRV / 靜息心率 / 睡眠分數 / 呼吸頻率 / 手腕體溫）。分數有算出來但只反映目前能讀到的訊號，不是完整 recovery 圖像。建議 Apple Watch 持續配戴 + 確認睡眠排程開啟。`);
  }

  // Today's interpretation paragraph
  if (driver) {
    const isPushUp = driver.contribution >= 0;
    const drvSign = isPushUp ? "拉高" : "拉低";
    const drvClass = isPushUp ? "good" : "alert";
    const trendText = !Number.isFinite(trend) ? "" :
      trend > 2 ? "整體還在改善趨勢中" :
      trend < -2 ? "整體在惡化趨勢中（建議減量、提早睡）" :
      "趨勢相對平穩";
    html += callout(drvClass,
      `<strong>今日狀態解讀</strong>　${todayDate} 分數 ${today.spec.toFixed(0)} / 100（${todayClass.label}）。` +
      `主要由 <strong>${driver.label}</strong> ${drvSign}（contribution = ${driver.contribution >= 0 ? "+" : ""}${driver.contribution.toFixed(2)}）。${trendText}。`);
  }

  // 365-day chart + threshold legend
  html += `<h3>📈 過去 365 天 Readiness 走勢</h3>`;
  html += `<p class="muted">綠 ≥ 75 = 可硬操、可做重要決策；紅 &lt; 40 = 建議減量、避免關鍵決策。橫虛線是這兩條閾值。</p>`;
  html += `<div id="t6-chart" class="task-chart"></div>`;
  html += `<p class="muted">在這個分析期間：🟢 綠燈 ${greens.length} 天 (${(greens.length / finiteIdx.length * 100).toFixed(0)}%)　·　🔴 紅燈 ${reds.length} 天 (${(reds.length / finiteIdx.length * 100).toFixed(0)}%)</p>`;

  // Component breakdown today
  html += `<h3>🧩 今日各組成成分</h3>`;
  html += `<p class="muted">每個組成的 scaled z-score（理想值靠近 +2，警戒在 -2）和它對今日總分的加權貢獻。</p>`;
  const compRows = ["hrv", "rhr", "sleep", "resp", "temp"].map((k) => {
    const c = today.components[k];
    if (!(k in today.components)) {
      return [COMPONENT_LABEL[k], `${(READINESS_WEIGHTS.spec[k] * 100).toFixed(0)} %`, "—", "—"];
    }
    const contrib = READINESS_WEIGHTS.spec[k] * c;
    return [
      COMPONENT_LABEL[k],
      `${(READINESS_WEIGHTS.spec[k] * 100).toFixed(0)} %`,
      c.toFixed(2),
      `<span style="color:${contrib >= 0 ? "var(--good)" : "var(--bad)"}">${contrib >= 0 ? "+" : ""}${contrib.toFixed(2)}</span>`,
    ];
  });
  html += tableHtml(["成分", "權重", "今日 scaled z", "今日加權貢獻"], compRows, { numCols: [1, 2, 3] });

  // Sensitivity table
  html += `<h3>🎚 權重敏感度（換組權重結果差多少？）</h3>`;
  html += `<p class="muted">用四組合理的權重各自算今天的分數。如果四個結果差異很大，代表你今天的訊號不一致，分數脆弱；差異小代表訊號一致、結論穩。</p>`;
  html += tableHtml(
    ["權重組合", "HRV / RHR / 睡眠 / 呼吸 / 體溫 (%)", "今日分數", "燈號"],
    sensRows, { numCols: [2] });

  container.innerHTML = html;

  // Render the 365-day plot
  if (typeof Plotly !== "undefined") {
    const div = document.getElementById("t6-chart");
    if (div) {
      const dates = frame.rows.map((r) => r.date);
      const traces = [
        { x: dates, y: specSeries, type: "scatter", mode: "lines+markers",
          line: { width: 2, color: "#4f8cff" },
          marker: {
            size: 5,
            color: specSeries.map((v) => readinessClassFromValue(v).color),
          },
          name: "Readiness",
          hovertemplate: "%{x}<br>分數 %{y:.0f}<extra></extra>",
        },
      ];
      Plotly.newPlot(div, traces, {
        paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
        font: { color: "#e6e9ef", family: "inherit", size: 11 },
        margin: { l: 50, r: 20, t: 20, b: 40 },
        xaxis: { gridcolor: "rgba(127,127,127,0.08)" },
        yaxis: { range: [0, 100], gridcolor: "rgba(127,127,127,0.08)",
                 title: { text: "Readiness", font: { size: 11 } } },
        shapes: [
          { type: "line", xref: "paper", x0: 0, x1: 1, y0: 75, y1: 75,
            line: { color: "var(--good)", width: 1, dash: "dot" } },
          { type: "line", xref: "paper", x0: 0, x1: 1, y0: 40, y1: 40,
            line: { color: "var(--bad)", width: 1, dash: "dot" } },
        ],
        height: 320, showlegend: false,
      }, { displaylogo: false, responsive: true });
    }
  }
}
// Helper: is this index an "anomaly day" by the brief's definition?
//   HRV_z < -1 OR resting_hr_z > +1
function isRecoveryAnomaly(hrvZ, rhrZ, i) {
  return (Number.isFinite(hrvZ[i]) && hrvZ[i] < -1) ||
         (Number.isFinite(rhrZ[i]) && rhrZ[i] > 1);
}

export function renderTask7(frame, container) {
  if (!frame || frame.rows.length < 30) {
    container.innerHTML = `<h2 class="task-title">🤒 任務 7：生病早警</h2>` +
      emptyState("資料量太少，至少需要 30 天讓 baseline + z-score 形成。");
    return;
  }

  const required = ["respiratory_zscore30", "wrist_temp_delta_c_zscore30",
                    "hrv_zscore30", "resting_hr_zscore30"];
  const missing = required.filter((c) => !frame.columns.includes(c) ||
    !columnValues(frame, c).some(Number.isFinite));
  if (missing.length) {
    container.innerHTML = `<h2 class="task-title">🤒 任務 7：生病早警</h2>` +
      callout("warn", `<strong>⚠ 缺少 z-score：</strong>${missing.join(" / ")}<br>` +
        `需要 30 天 baseline 才會有 z-score。確認你資料裡有「呼吸頻率」+「睡眠手腕溫差」+「HRV」+「靜息心率」並且累積 ≥ 30 天。`);
    return;
  }

  const respZ = columnValues(frame, "respiratory_zscore30");
  const tempZ = columnValues(frame, "wrist_temp_delta_c_zscore30");
  const hrvZ = columnValues(frame, "hrv_zscore30");
  const rhrZ = columnValues(frame, "resting_hr_zscore30");

  // 1. Warning days: respiratory_z > 1 AND wrist_temp_delta_z > 1 同時
  const warningDays = [];
  for (let i = 0; i < frame.rows.length; i++) {
    if (Number.isFinite(respZ[i]) && Number.isFinite(tempZ[i]) &&
        respZ[i] > 1 && tempZ[i] > 1) {
      warningDays.push({ idx: i, date: frame.rows[i].date, respZ: respZ[i], tempZ: tempZ[i] });
    }
  }

  // 2. Per warning day, scan next 7 days for the longest "anomaly run".
  //    "Real onset" = run ≥ 3 days (per brief).
  for (const w of warningDays) {
    let longest = 0, cur = 0;
    const horizon = Math.min(frame.rows.length, w.idx + 1 + 7);
    for (let j = w.idx + 1; j < horizon; j++) {
      if (isRecoveryAnomaly(hrvZ, rhrZ, j)) {
        cur++; if (cur > longest) longest = cur;
      } else cur = 0;
    }
    w.postWindow = horizon - (w.idx + 1);    // observed days available
    w.postRun = longest;
    w.outcome = w.postWindow < 7 ? "ongoing" :
                longest >= 3      ? "onset" :
                longest > 0       ? "partial" : "none";
  }

  // 3. Onset events: ≥ 5 consecutive anomaly days (per brief)
  const onsetEvents = [];
  let runStart = -1;
  for (let i = 0; i < frame.rows.length; i++) {
    if (isRecoveryAnomaly(hrvZ, rhrZ, i)) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0 && i - runStart >= 5) {
        onsetEvents.push({ start: runStart, end: i - 1, len: i - runStart });
      }
      runStart = -1;
    }
  }
  if (runStart >= 0 && frame.rows.length - runStart >= 5) {
    onsetEvents.push({ start: runStart, end: frame.rows.length - 1, len: frame.rows.length - runStart });
  }

  // 4. Sensitivity: of all onset events, what fraction had a warning day in the
  //    1-3 days before the event started?
  let warnedEvents = 0;
  for (const ev of onsetEvents) {
    const matched = warningDays.find((w) => {
      const lead = ev.start - w.idx;
      return lead >= 1 && lead <= 3;
    });
    if (matched) { ev.warning = { day: matched.date, lead: ev.start - matched.idx }; warnedEvents++; }
  }
  const sensitivity = onsetEvents.length > 0 ? warnedEvents / onsetEvents.length : NaN;

  // Today's row (latest finite z-score for the warning conditions)
  let todayIdx = -1;
  for (let i = frame.rows.length - 1; i >= 0; i--) {
    if (Number.isFinite(respZ[i]) && Number.isFinite(tempZ[i])) { todayIdx = i; break; }
  }
  const isTodayWarning = todayIdx >= 0 && respZ[todayIdx] > 1 && tempZ[todayIdx] > 1;
  const todayCard = isTodayWarning
    ? { emoji: "🔴", label: "警戒日", cls: "alert" }
    : { emoji: "🟢", label: "正常", cls: "good" };

  // ---- Render ----
  let html = `<h2 class="task-title">🤒 任務 7：生病早警</h2>`;
  html += `<p class="task-intro">Apple Watch 研究顯示「呼吸頻率上升 + 手腕體溫上升」常比體感發病早 1-2 天。這個分頁找出歷史警戒日 + 驗證對你個人的預警命中率。</p>`;

  // Top 3 stat cards
  html += `<div class="metric-grid">`;
  html += statCard({
    label: "今日狀態",
    value: todayCard.emoji,
    subtitle: todayIdx >= 0
      ? `${frame.rows[todayIdx].date}　·　呼吸 z = ${respZ[todayIdx].toFixed(2)}　·　體溫 z = ${tempZ[todayIdx].toFixed(2)}`
      : "缺資料",
    status: todayCard,
    hint: isTodayWarning
      ? "建議減量、提早休息、補水；2-3 天內再觀察 HRV / RHR"
      : "兩個早警訊號都在正常範圍",
  });
  html += statCard({
    label: "歷史警戒日",
    value: warningDays.length.toString(),
    subtitle: `分析期間 ${frame.rows.length} 天 · 共 ${onsetEvents.length} 次發病事件`,
    status: warningDays.length === 0
      ? { emoji: "🟢", label: "無", cls: "good" }
      : { emoji: "🔵", label: "有紀錄", cls: "fair" },
    hint: "警戒日 = 呼吸頻率 z > 1 且 手腕體溫 z > 1 同時",
  });
  html += statCard({
    label: "預警敏感度",
    value: Number.isFinite(sensitivity) ? (sensitivity * 100).toFixed(0) + "%" : "—",
    subtitle: `${warnedEvents} / ${onsetEvents.length} 次發病事件，警戒日在 1-3 天前先觸發`,
    status: !Number.isFinite(sensitivity)
      ? { emoji: "⚪", label: "無事件", cls: "empty" }
      : sensitivity >= 0.7 ? { emoji: "🟢", label: "可信", cls: "good" }
      : sensitivity >= 0.4 ? { emoji: "🔵", label: "中等", cls: "fair" }
      : { emoji: "🟡", label: "偏低", cls: "low" },
    hint: "對你而言，呼吸 + 體溫雙警對「真的發病」的命中率",
  });
  html += `</div>`;

  // Today warning callout (prominent)
  if (isTodayWarning) {
    html += callout("alert",
      `<strong>⚠ 今日（${frame.rows[todayIdx].date}）為警戒日</strong>　呼吸 z = ${respZ[todayIdx].toFixed(2)}σ、手腕體溫 z = ${tempZ[todayIdx].toFixed(2)}σ。建議減少行程、提早睡、補水，明後兩天再觀察 HRV / 靜息心率走勢；如果接下來 3 天 HRV 持續低於基線，大概率正在進入發病期。`);
  }

  // Warning days history
  html += `<h3>📋 歷史警戒日 + 後續發病判定</h3>`;
  html += `<p class="muted">每個警戒日往後看 7 天，找最長的「恢復異常」連續天數（HRV z &lt; -1 或 RHR z &gt; +1）。≥ 3 天 = 真的進展為發病模式。</p>`;
  if (!warningDays.length) {
    html += `<p class="muted">分析期間沒有偵測到警戒日。</p>`;
  } else {
    const outcomeMap = {
      onset:   { color: "var(--bad)",  text: (n) => `✗ 進展為發病 (${n} 天連續異常)` },
      partial: { color: "var(--warn)", text: (n) => `△ 部分異常 (${n} 天，未連續 3)` },
      none:    { color: "var(--good)", text: () => "✓ 未進展" },
      ongoing: { color: "var(--info)", text: () => "… 觀察中（後 7 天還沒過完）" },
    };
    const rows = warningDays.slice().reverse().slice(0, 30).map((w) => {
      const o = outcomeMap[w.outcome];
      return [
        w.date,
        w.respZ.toFixed(2) + "σ",
        w.tempZ.toFixed(2) + "σ",
        `<span style="color:${o.color}">${o.text(w.postRun)}</span>`,
      ];
    });
    html += tableHtml(["日期", "呼吸 z", "體溫 z", "後 7 天判定"], rows, { numCols: [1, 2] });
    if (warningDays.length > 30) html += `<p class="muted">（顯示最近 30 筆，共 ${warningDays.length} 筆）</p>`;
  }

  // Onset events history (with predictive matching)
  html += `<h3>📅 歷史發病事件（≥ 5 天恢復異常）</h3>`;
  if (!onsetEvents.length) {
    html += `<p class="muted">分析期間沒有偵測到 ≥ 5 天連續恢復異常的事件。</p>`;
  } else {
    const rows = onsetEvents.slice().reverse().map((ev) => [
      `${frame.rows[ev.start].date} → ${frame.rows[ev.end].date}`,
      `${ev.len} 天`,
      ev.warning
        ? `<span style="color:var(--good)">✓ ${ev.warning.day} 提前 ${ev.warning.lead} 天</span>`
        : `<span style="color:var(--bad)">✗ 沒有 1-3 天前的警戒</span>`,
    ]);
    html += tableHtml(["事件期間", "持續", "警戒日預測"], rows, { numCols: [1] });
  }

  container.innerHTML = html;
}
