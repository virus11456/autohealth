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
  const baselineLabel = mode === "rolling30" ? "比平常" :
                        mode === "overall"   ? "比整體平均" :
                                               "資料不足";
  const phrase = deltaPhrase(z, higherIsBetter);
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
        <span class="muted">${baselineLabel} ${fmtV(baseline)}${unit}　·　<span style="color:var(--${phrase.cls})">${phrase.word}</span></span>
      </div>
      <div id="${chartId}" class="metric-chart"></div>
      ${hint ? `<div class="metric-hint muted">${hint}</div>` : ""}
    </div>`;
}

// Render a line chart with raw values connected, 30-day rolling mean
// overlay, and a dashed horizontal "your average" reference line so users
// can directly read "above or below personal baseline" at a glance.
function drawMetricChart(divId, dates, raw, smooth, color, opts = {}) {
  const div = document.getElementById(divId);
  if (!div || typeof Plotly === "undefined") return;
  const baseline = meanFinite(raw);
  const traces = [
    { x: dates, y: raw, mode: "lines+markers", type: "scatter",
      line: { width: 1.4, color, shape: "linear" },
      marker: { size: 3, color },
      connectgaps: false,
      name: "每日值", showlegend: false,
      hovertemplate: `%{x}<br>%{y:.2f}<extra></extra>` },
    { x: dates, y: smooth, mode: "lines", type: "scatter",
      line: { width: 2.5, color, dash: "solid" },
      opacity: 0.55,
      name: "30 天均", showlegend: false,
      hovertemplate: `%{x}<br>30d 均: %{y:.2f}<extra></extra>` },
  ];
  const shapes = [];
  if (Number.isFinite(baseline)) {
    shapes.push({
      type: "line", xref: "paper", x0: 0, x1: 1,
      y0: baseline, y1: baseline,
      line: { color: "rgba(255,255,255,0.35)", width: 1, dash: "dash" },
    });
  }
  Plotly.newPlot(div, traces, {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#8b94a7", family: "inherit", size: 10 },
    margin: { l: 36, r: 8, t: 6, b: 22 },
    xaxis: { gridcolor: "rgba(127,127,127,0.08)", tickfont: { size: 9 }, fixedrange: true },
    yaxis: { gridcolor: "rgba(127,127,127,0.08)", tickfont: { size: 9 }, fixedrange: true },
    height: opts.height || 140,
    hovermode: "x unified",
    showlegend: false,
    shapes,
  }, { displaylogo: false, responsive: true, displayModeBar: false });
}

// 3-panel combined chart for the Readiness triangle. Stacks HRV / RHR /
// walking_HR with a shared x-axis so the user can scan vertically and tell
// whether all three are moving in the "good" direction simultaneously
// (= recovering / fitter) or all in the "bad" direction (= fatigue / sick).
function drawTriangleCombined(divId, dates, hrv, rhr, walking) {
  const div = document.getElementById(divId);
  if (!div || typeof Plotly === "undefined") return;
  const hrvBase = meanFinite(hrv);
  const rhrBase = meanFinite(rhr);
  const walkBase = meanFinite(walking);
  const hrvSm = rollingMean(hrv, 30);
  const rhrSm = rollingMean(rhr, 30);
  const walkSm = rollingMean(walking, 30);

  const traces = [
    { x: dates, y: hrv, mode: "lines+markers", type: "scatter",
      line: { width: 1.4, color: "#34c38f" }, marker: { size: 3, color: "#34c38f" },
      name: "心跳變化 HRV", connectgaps: false, xaxis: "x", yaxis: "y",
      hovertemplate: "%{x}<br>HRV %{y:.1f} ms<extra></extra>" },
    { x: dates, y: hrvSm, mode: "lines", type: "scatter",
      line: { width: 2.5, color: "#34c38f" }, opacity: 0.55, showlegend: false,
      xaxis: "x", yaxis: "y", hoverinfo: "skip" },
    { x: dates, y: rhr, mode: "lines+markers", type: "scatter",
      line: { width: 1.4, color: "#ef4444" }, marker: { size: 3, color: "#ef4444" },
      name: "靜息心率", connectgaps: false, xaxis: "x", yaxis: "y2",
      hovertemplate: "%{x}<br>RHR %{y:.0f} bpm<extra></extra>" },
    { x: dates, y: rhrSm, mode: "lines", type: "scatter",
      line: { width: 2.5, color: "#ef4444" }, opacity: 0.55, showlegend: false,
      xaxis: "x", yaxis: "y2", hoverinfo: "skip" },
    { x: dates, y: walking, mode: "lines+markers", type: "scatter",
      line: { width: 1.4, color: "#f0a020" }, marker: { size: 3, color: "#f0a020" },
      name: "走路心跳", connectgaps: false, xaxis: "x", yaxis: "y3",
      hovertemplate: "%{x}<br>走路 HR %{y:.0f} bpm<extra></extra>" },
    { x: dates, y: walkSm, mode: "lines", type: "scatter",
      line: { width: 2.5, color: "#f0a020" }, opacity: 0.55, showlegend: false,
      xaxis: "x", yaxis: "y3", hoverinfo: "skip" },
  ];
  const dashLine = (yref, val) => Number.isFinite(val) ? {
    type: "line", xref: "paper", x0: 0, x1: 1, y0: val, y1: val, yref,
    line: { color: "rgba(255,255,255,0.30)", width: 1, dash: "dash" },
  } : null;
  Plotly.newPlot(div, traces, {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#e6e9ef", family: "inherit", size: 11 },
    margin: { l: 60, r: 20, t: 30, b: 40 },
    xaxis: { domain: [0, 1], anchor: "y3",
             gridcolor: "rgba(127,127,127,0.08)", tickfont: { size: 10 } },
    yaxis:  { domain: [0.70, 1.00], gridcolor: "rgba(127,127,127,0.08)",
              title: { text: "HRV (ms)　好↑", font: { size: 10 } } },
    yaxis2: { domain: [0.37, 0.65], gridcolor: "rgba(127,127,127,0.08)",
              title: { text: "靜息心跳 (bpm)　好↓", font: { size: 10 } } },
    yaxis3: { domain: [0.00, 0.28], gridcolor: "rgba(127,127,127,0.08)",
              title: { text: "走路心跳 (bpm)　好↓", font: { size: 10 } } },
    shapes: [dashLine("y", hrvBase), dashLine("y2", rhrBase), dashLine("y3", walkBase)].filter(Boolean),
    height: 540,
    hovermode: "x unified",
    showlegend: true,
    legend: { orientation: "h", y: 1.05, x: 0.5, xanchor: "center" },
  }, { displaylogo: false, responsive: true });
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

  // ---- Today's verdict (computed from latest day where these metrics exist) ----
  const todayIdx = Math.max(lastFiniteIdx(hrv), lastFiniteIdx(rhr), lastFiniteIdx(walking));
  const tRow = todayIdx >= 0 ? frame.rows[todayIdx] : null;
  const tHrvZ = tRow?.hrv_zscore30;
  const tRhrZ = tRow?.resting_hr_zscore30;
  const tWalkZ = tRow?.walking_hr_zscore30;
  let goodDirs = 0, badDirs = 0;
  if (Number.isFinite(tHrvZ))  { if (tHrvZ > 0.5)  goodDirs++; else if (tHrvZ < -0.5) badDirs++; }
  if (Number.isFinite(tRhrZ))  { if (tRhrZ < -0.5) goodDirs++; else if (tRhrZ > 0.5)  badDirs++; }
  if (Number.isFinite(tWalkZ)) { if (tWalkZ < -0.5) goodDirs++; else if (tWalkZ > 0.5) badDirs++; }
  const haveAny = Number.isFinite(tHrvZ) || Number.isFinite(tRhrZ) || Number.isFinite(tWalkZ);

  let verdict;
  if (!haveAny) {
    verdict = verdictPanel({
      cls: "empty", emoji: "⚪",
      headline: "資料還不夠",
      detail: "需要至少幾週的記錄才看得出趨勢。",
    });
  } else if (goodDirs >= 2 && badDirs === 0) {
    verdict = verdictPanel({
      cls: "good", emoji: "🟢",
      headline: "今天身體狀態不錯",
      detail: "心跳、放鬆度、運動心跳都比平常好——身體在累積進步。",
      action: "今天可以正常活動 / 訓練 / 工作。",
    });
  } else if (badDirs >= 2 && goodDirs === 0) {
    verdict = verdictPanel({
      cls: "alert", emoji: "🔴",
      headline: "身體比平常累，要注意",
      detail: "好幾個訊號都比平常差，可能是太累、睡不夠、或是快感冒。這種訊號通常比你自己感覺到不舒服早 1-2 天。",
      action: "今天早點睡 + 多喝水 + 減少行程；明後天再看一次。",
    });
  } else if (badDirs >= 1) {
    verdict = verdictPanel({
      cls: "low", emoji: "🟡",
      headline: "有些訊號跟平常不一樣",
      detail: "一兩個指標偏離平常，但還沒到警戒。",
      action: "維持作息，明天再觀察看看。",
    });
  } else {
    verdict = verdictPanel({
      cls: "fair", emoji: "🔵",
      headline: "跟平常差不多",
      detail: "心跳、放鬆度都接近你的平常水準。",
      action: "繼續維持就好。",
    });
  }

  // ---- Render ----
  let html = `<h2 class="task-title">🔋 任務 2：身體狀態三角</h2>`;
  html += `<p class="task-intro">看你身體的三個訊號：心跳變化（HRV）、躺著時的心跳（靜息心率）、走路時的心跳。三個一起看比單看一個準。</p>`;
  html += verdict;

  // Card row: today's value + delta vs 30-day baseline + mini chart, per metric.
  html += `<h3>📊 三個訊號現況</h3>`;
  html += `<div class="metric-grid">`;
  html += metricCard({
    chartId: "t2-chart-hrv", label: "心跳變化 (HRV)", unit: " ms",
    dates, raw: hrv, smooth: hrvSm, higherIsBetter: true,
    frameRows: frame.rows, baselineKey: "hrv",
    hint: "數字越高 = 身體越放鬆、恢復力越好",
  });
  html += metricCard({
    chartId: "t2-chart-rhr", label: "靜息心率", unit: " bpm",
    dates, raw: rhr, smooth: rhrSm, higherIsBetter: false,
    frameRows: frame.rows, baselineKey: "resting_hr",
    hint: "躺著時的心跳。越低 = 心臟越強壯",
  });
  html += metricCard({
    chartId: "t2-chart-walking", label: "走路心跳", unit: " bpm",
    dates, raw: walking, smooth: walkingSm, higherIsBetter: false,
    frameRows: frame.rows, baselineKey: "walking_hr",
    hint: "走相同距離的心跳。越低 = 走路越省力",
  });
  html += `</div>`;

  // Combined 3-panel view — same x-axis, three independent y-axes.
  // Reads vertically: at any date, are all three lines on the "good" side of
  // their dashed personal-baseline? If yes → recovery. All on "bad" side → fatigue.
  html += `<h3>🔄 三個訊號疊在一起看</h3>`;
  html += `<p class="muted" style="margin:0 0 8px 0;">虛線是「你個人的平均」。理想：HRV 在虛線上面、靜息心跳在虛線下面、走路心跳在虛線下面（=三個都在好的方向）。如果三個同時跑到「不好的那邊」，就要小心是不是太累或快感冒。</p>`;
  html += `<div id="t2-combined" class="task-chart"></div>`;

  // Correlation matrix on RAW values (Spearman is rank-based; z-score
  // standardisation is a monotonic transform and produces identical ranks,
  // so using raw values is mathematically equivalent but covers many more
  // days when z-score columns are sparse — a real concern with light wearers).
  html += `<h3>🔗 三角相關矩陣 (Spearman)</h3>`;
  html += `<p class="muted" style="margin: 0 0 8px 0;">用每日數值算 Spearman 排序相關（對非線性 / 離群值穩健）。藍 = 正相關，紅 = 負相關。健康狀況下：HRV ↔ RHR 應該是負，HRV ↔ 步行 HR 應該是負，RHR ↔ 步行 HR 應該是正。</p>`;
  html += corrMatrixHtml(["HRV", "靜息 HR", "步行 HR"], [hrv, rhr, walking]);

  // ---- 最近 7 天會不會生病 ----
  // Scan the last 7 finite-z days. A "bad" day = ≥ 2 of HRV / RHR / walking_HR
  // pointing in the wrong direction (HRV low, RHR high, walking_HR high).
  // Cluster of consecutive bad days = real warning.
  const recentLookback = 7;
  let badDays = 0, maxConsecutive = 0, curConsecutive = 0;
  let evaluatedDays = 0;
  for (let i = Math.max(0, frame.rows.length - recentLookback); i < frame.rows.length; i++) {
    const r = frame.rows[i];
    const hZ = r.hrv_zscore30, rZ = r.resting_hr_zscore30, wZ = r.walking_hr_zscore30;
    if (![hZ, rZ, wZ].some(Number.isFinite)) continue;
    evaluatedDays++;
    let bad = 0;
    if (Number.isFinite(hZ) && hZ < -0.5) bad++;
    if (Number.isFinite(rZ) && rZ > 0.5) bad++;
    if (Number.isFinite(wZ) && wZ > 0.5) bad++;
    if (bad >= 2) {
      badDays++; curConsecutive++;
      if (curConsecutive > maxConsecutive) maxConsecutive = curConsecutive;
    } else {
      curConsecutive = 0;
    }
  }
  let illness;
  if (evaluatedDays === 0) {
    illness = { cls: "empty", emoji: "⚪", headline: "最近沒資料",
      detail: "最近 7 天三個訊號都還沒讀到，無法判斷。" };
  } else if (maxConsecutive >= 3) {
    illness = {
      cls: "alert", emoji: "🔴",
      headline: "可能 1-2 天內會感覺不舒服",
      detail: `最近 7 天裡有 ${maxConsecutive} 天連續訊號都偏壞——這常常比身體真的不舒服早 1-2 天出現。`,
      action: "立刻減量、提早休息、多補水。如果症狀真的出現，要好好休息或看醫生。",
    };
  } else if (badDays >= 3) {
    illness = {
      cls: "low", emoji: "🟡",
      headline: "有點訊號偏離平常",
      detail: `最近 7 天裡有 ${badDays} 天訊號偏壞，但還沒形成連續警訊。`,
      action: "今晚早點睡 + 多喝水，明後天再看一次有沒有變嚴重。",
    };
  } else {
    illness = {
      cls: "good", emoji: "🟢",
      headline: "最近沒有生病警訊",
      detail: `看了最近 ${evaluatedDays} 天，訊號穩定，沒有累積疲勞或感冒前兆。`,
      action: "維持現狀就好。",
    };
  }
  html += `<h3>🤒 最近 7 天會不會生病</h3>`;
  html += verdictPanel(illness);

  // ---- 心率訊號對身體的影響 ----
  const tIdx = lastFiniteIdx(hrv) >= 0 ? lastFiniteIdx(hrv) :
               lastFiniteIdx(rhr) >= 0 ? lastFiniteIdx(rhr) :
               lastFiniteIdx(walking);
  const tr = tIdx >= 0 ? frame.rows[tIdx] : null;
  const effects = [];
  if (tr) {
    const hZ = tr.hrv_zscore30;
    const rZ = tr.resting_hr_zscore30;
    const wZ = tr.walking_hr_zscore30;
    if (Number.isFinite(hZ)) {
      if (hZ > 0.5) effects.push({ kind: "good", title: "💚 心跳變化（HRV）比平常高",
        body: "身體很放鬆、自我修復狀態好。今天做事、運動、決策都會比較順、情緒也穩定。" });
      else if (hZ < -0.5) effects.push({ kind: "bad", title: "⚠ 心跳變化（HRV）比平常低",
        body: "身體比較緊繃，恢復速度變慢。可能會比較煩躁、容易發脾氣、做決定可能衝動。建議今天別碰太重要的決定。" });
    }
    if (Number.isFinite(rZ)) {
      if (rZ < -0.5) effects.push({ kind: "good", title: "💚 靜息心率比平常低",
        body: "心臟運作很有效率，睡眠 / 運動 / 飲食最近都顧得不錯。" });
      else if (rZ > 0.5) effects.push({ kind: "bad", title: "⚠ 靜息心率比平常高",
        body: "心臟在加班——常見原因：壓力大、水喝不夠、咖啡因 / 酒精太多、輕微發炎或感冒前兆、睡眠品質差。" });
    }
    if (Number.isFinite(wZ)) {
      if (wZ < -0.5) effects.push({ kind: "good", title: "💚 走路心跳比平常低",
        body: "心肺體能正在進步——同樣的活動更省力。" });
      else if (wZ > 0.5) effects.push({ kind: "bad", title: "⚠ 走路心跳比平常高",
        body: "同樣的活動消耗更多體力——可能是太久沒運動、訓練累積疲勞，或是身體在打感冒。" });
    }
  }

  html += `<h3>💡 心跳訊號現在對你身體的影響</h3>`;
  if (!effects.length) {
    html += `<p class="muted">三個訊號都接近平常水準，今天沒有特別偏離的影響。</p>`;
  } else {
    html += `<div class="effects-list">`;
    for (const e of effects) {
      html += `<div class="effect-item ${e.kind}">
        <div class="effect-title">${e.title}</div>
        <div class="effect-body">${e.body}</div>
      </div>`;
    }
    html += `</div>`;
  }

  container.innerHTML = html;

  // Charts must render after DOM is in place
  drawMetricChart("t2-chart-hrv", dates, hrv, hrvSm, "#34c38f");
  drawMetricChart("t2-chart-rhr", dates, rhr, rhrSm, "#ef4444");
  drawMetricChart("t2-chart-walking", dates, walking, walkingSm, "#f0a020");
  drawTriangleCombined("t2-combined", dates, hrv, rhr, walking);
}
// Big verdict panel — one-glance plain-language conclusion at the top of each
// task. Designed for non-experts: no σ / z-score / p-value jargon in copy.
function verdictPanel({ cls, emoji, headline, detail = "", action = "" }) {
  return `
    <div class="task-verdict ${cls}">
      <div class="task-verdict-icon">${emoji}</div>
      <div class="task-verdict-content">
        <div class="task-verdict-headline">${headline}</div>
        ${detail ? `<div class="task-verdict-detail">${detail}</div>` : ""}
        ${action ? `<div class="task-verdict-action">${action}</div>` : ""}
      </div>
    </div>`;
}

// Plain-language phrasing for "today's value vs personal baseline" delta.
// Avoids σ notation in main display — only the size of the deviation matters.
function deltaPhrase(z, higherIsBetter) {
  if (!Number.isFinite(z)) return { word: "資料不足", cls: "muted" };
  const abs = Math.abs(z);
  const isGood = higherIsBetter ? z > 0 : z < 0;
  let mag;
  if (abs < 0.5)      mag = "差不多";
  else if (abs < 1)   mag = isGood ? "略好" : "略差";
  else if (abs < 2)   mag = isGood ? "明顯比平常好" : "明顯比平常差";
  else                mag = isGood ? "非常好" : "明顯偏離";
  return { word: mag, cls: abs < 0.5 ? "muted" : isGood ? "good" : "bad" };
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

// Plain-language version: how strong is the influence (one-direction r magnitude).
function corrStrengthPlain(r) {
  if (!Number.isFinite(r)) return { emoji: "⚪", label: "資料不夠", cls: "empty" };
  const abs = Math.abs(r);
  if (abs >= 0.5) return { emoji: "🟢", label: "影響很大", cls: "good" };
  if (abs >= 0.3) return { emoji: "🔵", label: "影響中等", cls: "fair" };
  if (abs >= 0.15) return { emoji: "🟡", label: "影響有限", cls: "low" };
  return { emoji: "⚪", label: "沒明顯影響", cls: "empty" };
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
    { id: "A", name: "睡多久（總時數）",
      desc: "排除深睡 / REM 影響後的單純時長效應",
      hint: "睡得越久，隔天身體越放鬆",
      r: hypA.r, n: hypA.n,
      tips: [
        "今晚比平常早 30 分鐘上床",
        "週末別補眠補太多（會打亂作息）",
        "睡前 1 小時不要再排事情",
      ] },
    { id: "B", name: "深睡睡多久",
      desc: "排除總時長 / REM 影響後的深睡效應",
      hint: "深睡分鐘多 = 身體真的在修復",
      r: hypB.r, n: hypB.n,
      tips: [
        "睡前 3 小時內不要喝酒（深睡的最大殺手）",
        "房間溫度涼一點（18-20 度）",
        "睡前 1 小時不要看螢幕（藍光抑制深睡）",
      ] },
    { id: "C", name: "睡得深 + 做夢的比例",
      desc: "(深睡 + REM) ÷ 總睡眠時間",
      hint: "比例高 = 睡得有效率",
      r: hypC.r, n: hypC.n,
      tips: [
        "固定每天差不多時間上床 / 起床（含週末）",
        "床只用來睡覺，不要在床上工作 / 滑手機",
        "白天充足日照，睡前盡量黑暗",
      ] },
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
  let html = `<h2 class="task-title">💤 任務 3：睡眠 → 隔天精神</h2>`;
  html += `<p class="task-intro">看你「昨晚怎麼睡」對「今天精神恢復」的影響有多大，找出對你最有用的睡眠優化方向。</p>`;

  // Top verdict
  const winnerStrength = corrStrengthPlain(winner.r);
  if (Number.isFinite(winner.r) && Math.abs(winner.r) >= 0.15) {
    html += verdictPanel({
      cls: winnerStrength.cls, emoji: winnerStrength.emoji,
      headline: `對你最有用的睡眠優化：${winner.name}`,
      detail: `根據你的資料，${winner.name}對隔天 HRV 的影響最大。` +
              (winner.r > 0 ? "這個面向越好 → 你隔天的恢復越好。" : "這個面向越多 → 隔天反而 HRV 越低，需要再多資料確認。"),
      action: winner.tips ? winner.tips[0] : "",
    });
  } else {
    html += verdictPanel({
      cls: "low", emoji: "🟡",
      headline: "三個面向影響都不明顯",
      detail: "可能是資料還不夠多，或睡眠以外的因素（壓力、運動、咖啡因）影響更大。",
      action: "繼續累積資料；同時注意睡眠規律 + 睡前不喝酒 + 房間涼。",
    });
  }

  // 3 hypothesis cards (plain language)
  html += `<h3>🧪 三個睡眠面向各有多重要</h3>`;
  html += `<p class="muted" style="margin: 0 0 8px 0;">數據比較：哪一個睡眠特徵最影響你隔天的精神。</p>`;
  html += `<div class="metric-grid">`;
  for (const h of hypotheses) {
    const status = corrStrengthPlain(h.r);
    html += statCard({
      label: h.name,
      value: status.label,
      subtitle: h.hint + `　·　樣本 ${h.n} 天`,
      status,
      hint: h.desc,
    });
  }
  html += `</div>`;

  // Action tips for winner (only if winner is meaningful)
  if (winner.tips && Number.isFinite(winner.r) && Math.abs(winner.r) >= 0.15) {
    html += `<h3>🎯 你最該優化的：${winner.name}</h3>`;
    html += `<div class="effects-list">`;
    for (const tip of winner.tips) {
      html += `<div class="effect-item good">
        <div class="effect-body">✓ ${tip}</div>
      </div>`;
    }
    html += `</div>`;
  }

  // Sleep score binning boxplot — visual is intuitive, keep it
  html += `<h3>📊 睡得越好 → 隔天精神越好嗎？</h3>`;
  html += `<p class="muted">把昨晚的睡眠分數分成 4 段（差 / 普通 / 好 / 很好），看隔天 HRV（精神恢復力）的分佈。如果你睡得越好、隔天 HRV 真的越高 → 圖中柱子應該越往上。</p>`;
  html += tableHtml(["昨晚睡眠分數", "天數", "隔天精神（平均 HRV）"],
    binSummary.map((b) => [b.label, b.n, Number.isFinite(b.mean) ? b.mean.toFixed(1) + " ms" : "—"]),
    { numCols: [1, 2] });
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

  // ---- Today's verdict ----
  const tIdx4 = lastFiniteIdx(asym) >= 0 ? lastFiniteIdx(asym) : lastFiniteIdx(ds);
  const tr4 = tIdx4 >= 0 ? frame.rows[tIdx4] : null;
  const todayAsym = tr4?.walking_asymmetry;
  const todayDs = tr4?.double_support;
  const gaitWarnings = [];
  const gaitGood = [];
  const gaitEffects = [];

  if (Number.isFinite(todayAsym)) {
    if (todayAsym > 3) {
      gaitWarnings.push(`走路有點偏一邊（${todayAsym.toFixed(1)}%）`);
      gaitEffects.push({ kind: "bad", title: "⚠ 走路偏一邊",
        body: "可能單側膝蓋 / 髖關節磨損加速、容易腰痠。常見原因：舊傷、長短腳、髖屈肌緊。建議做髖關節伸展，或找物理治療師評估。" });
    } else if (todayAsym <= 2) {
      gaitGood.push("走路左右平均");
    }
  }
  if (Number.isFinite(todayDs)) {
    if (todayDs > 30) {
      gaitWarnings.push(`走路太保守（雙腳同時著地時間 ${todayDs.toFixed(0)}%）`);
      gaitEffects.push({ kind: "bad", title: "⚠ 走路太「貼地」",
        body: "雙腳同時著地的時間偏長 → 平衡感下降 / 跌倒風險上升。常見原因：年齡、神經系統不穩、腳踝或膝蓋有問題。建議做單腳平衡訓練。" });
    } else if (todayDs >= 22 && todayDs <= 28) {
      gaitGood.push("步態節奏正常");
    }
  }
  // Speed / length deltas vs baseline (use frame baselines if available, else overall)
  const wsLatestZ = (() => {
    const ws30 = tr4?.walking_speed_mps; if (!Number.isFinite(ws30)) return NaN;
    const m = meanFinite(ws), s = stdFinite(ws); return s > 0 ? (ws30 - m) / s : NaN;
  })();
  const slLatestZ = (() => {
    const sl30 = tr4?.step_length_cm; if (!Number.isFinite(sl30)) return NaN;
    const m = meanFinite(sl), s = stdFinite(sl); return s > 0 ? (sl30 - m) / s : NaN;
  })();
  if (Number.isFinite(wsLatestZ) && wsLatestZ < -0.7) {
    gaitWarnings.push("走路速度比平常慢");
    gaitEffects.push({ kind: "bad", title: "⚠ 走路比平常慢",
      body: "心肺體能或腿力可能下降。如果是短期偏慢可能是累，如果持續好幾週要注意。" });
  } else if (Number.isFinite(wsLatestZ) && wsLatestZ > 0.7) {
    gaitGood.push("走路速度好");
  }
  if (Number.isFinite(slLatestZ) && slLatestZ < -0.7) {
    gaitWarnings.push("步伐變小");
    gaitEffects.push({ kind: "bad", title: "⚠ 步伐比平常小",
      body: "腿力 / 髖屈肌活動度可能下降，或單純太累。建議做髖伸展 + 弓箭步。" });
  }

  let gaitVerdict;
  if (!Number.isFinite(todayAsym) && !Number.isFinite(todayDs)) {
    gaitVerdict = { cls: "empty", emoji: "⚪", headline: "資料不足",
      detail: "沒有最近的步態資料。Apple Watch 要佩戴 + 走路 30 秒以上才會記錄。" };
  } else if (gaitWarnings.length === 0) {
    gaitVerdict = { cls: "good", emoji: "🟢", headline: "走路狀態正常",
      detail: gaitGood.length ? `表現：${gaitGood.join("、")}。` : "各項數值都在正常範圍。",
      action: "繼續維持目前的活動量。" };
  } else if (gaitWarnings.length === 1) {
    gaitVerdict = { cls: "low", emoji: "🟡", headline: "有一個地方要注意",
      detail: gaitWarnings[0] + "。其他指標還 OK。",
      action: "短期觀察 1-2 週，看是否持續。" };
  } else {
    gaitVerdict = { cls: "alert", emoji: "🔴", headline: "走路品質下降，可能在代償",
      detail: gaitWarnings.join("、") + "。多個指標一起惡化代表身體可能在偷工。",
      action: "減量訓練、做髖 / 腿伸展，必要時找物理治療師。" };
  }

  // ---- Render ----
  let html = `<h2 class="task-title">🚶 任務 4：走路品質</h2>`;
  html += `<p class="task-intro">看你「走路時身體會不會偷偷代償」。舊傷 / 髖緊 / 腿力下降常先在這裡出現訊號，比膝蓋真的痛起來早幾週。</p>`;
  html += verdictPanel(gaitVerdict);

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

  // ---- 對你身體的可能影響 (plain-language effect cards) ----
  if (gaitEffects.length) {
    html += `<h3>💡 走路狀態對你身體的可能影響</h3>`;
    html += `<div class="effects-list">`;
    for (const e of gaitEffects) {
      html += `<div class="effect-item ${e.kind}">
        <div class="effect-title">${e.title}</div>
        <div class="effect-body">${e.body}</div>
      </div>`;
    }
    html += `</div>`;
  }

  // ---- 走得多時會不會代償（plain-language version of high vs low day) ----
  html += `<h3>🏃 你走得多時，走路品質會不會變差？</h3>`;
  if (lowIdx.length < 5 || highIdx.length < 5) {
    html += `<p class="muted">資料還不夠多，先繼續累積。</p>`;
  } else {
    const sigBad = compareRows.filter((r) => Number.isFinite(r.t.p) && r.t.p < 0.05 &&
      ((r.higherBetter && r.highMean < r.lowMean) || (!r.higherBetter && r.highMean > r.lowMean)));
    const sigGood = compareRows.filter((r) => Number.isFinite(r.t.p) && r.t.p < 0.05 &&
      ((r.higherBetter && r.highMean > r.lowMean) || (!r.higherBetter && r.highMean < r.lowMean)));
    if (sigBad.length) {
      html += callout("low",
        `<strong>有點代償跡象</strong><br>` +
        `當你走比較多時，<strong>${sigBad.map((m) => m.label).join("、")}</strong> 變得明顯比較差。代表身體在大量行走時可能在偷工減料，長期累積容易受傷。<br>` +
        `→ 建議：高量行走的隔天安排輕鬆日，做髖 / 腿伸展。`);
    } else {
      html += callout("good",
        `<strong>很好，沒有代償跡象</strong><br>` +
        `就算你走得多，走路品質沒有明顯變差。代表你目前承受得住這個運動量。`);
    }
    // Brief data-backed table for power users (kept compact)
    html += `<details style="margin-top:8px;"><summary class="muted" style="cursor:pointer; font-size:0.85rem;">想看數字 (高 vs 低 10% 步數日)</summary>`;
    const cmpRows = compareRows.map((r) => {
      const diff = r.highMean - r.lowMean;
      const goodSign = r.higherBetter ? diff > 0 : diff < 0;
      const dirText = (diff >= 0 ? "+" : "") + diff.toFixed(2) + r.unit;
      return [
        r.label,
        Number.isFinite(r.lowMean) ? r.lowMean.toFixed(2) + r.unit : "—",
        Number.isFinite(r.highMean) ? r.highMean.toFixed(2) + r.unit : "—",
        `<span style="color:${goodSign ? 'var(--good)' : 'var(--bad)'}">${dirText}</span>`,
      ];
    });
    html += tableHtml(["指標", "走少日", "走多日", "差距"], cmpRows, { numCols: [1, 2, 3] });
    html += `</details>`;
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

  // ---- Today's verdict ----
  // Compute "circadian health" from recent daylight + bedtime stability +
  // last 7 days sleep score. We have plenty of helpful signals already.
  const last7Daylight = daylight.slice(-7).filter(Number.isFinite);
  const recentDaylightAvg = last7Daylight.length ? meanFinite(last7Daylight) : NaN;
  const bedStdLatest = latestStd?.std;

  const envWarnings = [];
  const envGood = [];
  const envEffects = [];

  if (Number.isFinite(recentDaylightAvg)) {
    if (recentDaylightAvg < 30) {
      envWarnings.push("最近曬太陽太少");
      envEffects.push({ kind: "bad", title: "⚠ 最近日照太少（< 30 分 / 天）",
        body: "太陽是讓身體分辨「白天 / 晚上」最強的訊號。長期日照不足 → 晚上深睡比下降、白天疲倦感、情緒容易低落。" });
    } else if (recentDaylightAvg >= 60) {
      envGood.push("曬太陽充足");
    }
  }
  if (Number.isFinite(bedStdLatest)) {
    if (bedStdLatest > 1.5) {
      envWarnings.push("作息很不穩");
      envEffects.push({ kind: "bad", title: "⚠ 上床時間天天不一樣（標準差 > 1.5 小時）",
        body: "身體有自己的時鐘——固定時間上床效率最高。作息亂 → 深睡比下降、HRV 下降、白天精神差。常見原因：輪班、加班、跨時區、追劇追到很晚。" });
    } else if (bedStdLatest <= 0.8) {
      envGood.push("作息固定");
    }
  }

  let envVerdict;
  if (!Number.isFinite(recentDaylightAvg) && !Number.isFinite(bedStdLatest)) {
    envVerdict = { cls: "empty", emoji: "⚪", headline: "資料不足",
      detail: "需要日照 + 睡眠時間紀錄才能看節律。" };
  } else if (envWarnings.length === 0) {
    envVerdict = { cls: "good", emoji: "🟢", headline: "節律狀態不錯",
      detail: envGood.length ? `表現：${envGood.join("、")}。` : "日照與作息都在正常範圍。",
      action: "繼續維持。" };
  } else if (envWarnings.length === 1) {
    envVerdict = { cls: "low", emoji: "🟡", headline: "有一個地方要調整",
      detail: envWarnings[0] + "，會慢慢影響你的睡眠 / 精神。",
      action: envWarnings[0].includes("曬太陽") ? "每天午前出門曬 15-30 分鐘太陽。" : "週間至少有 5 天固定上床時間。" };
  } else {
    envVerdict = { cls: "alert", emoji: "🔴", headline: "節律明顯失調",
      detail: envWarnings.join("、") + "。生理節律亂掉是「累、煩、淺睡、容易感冒」的根源。",
      action: "從一個簡單習慣開始：固定起床時間 + 早上曬太陽 10 分鐘。" };
  }

  // ---- Render ----
  let html = `<h2 class="task-title">🌅 任務 5：日照與作息</h2>`;
  html += `<p class="task-intro">看你「曬太陽夠不夠」+「作息穩不穩」對睡眠 / 精神的影響。生理節律是一切的基底——亂了之後 HRV、睡眠、情緒都會跟著亂。</p>`;
  html += verdictPanel(envVerdict);

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

  // ---- Effects on body (plain-language)
  if (envEffects.length) {
    html += `<h3>💡 對你身體的可能影響</h3>`;
    html += `<div class="effects-list">`;
    for (const e of envEffects) {
      html += `<div class="effect-item ${e.kind}">
        <div class="effect-title">${e.title}</div>
        <div class="effect-body">${e.body}</div>
      </div>`;
    }
    html += `</div>`;
  }

  // Daylight bin (visual is intuitive)
  html += `<h3>☀ 曬越多太陽 → 當晚睡得越好嗎？</h3>`;
  html += `<p class="muted">把每天的日照時間分成 4 段，看當晚的睡眠分數。</p>`;
  html += tableHtml(["日照", "天數", "當晚睡眠分數平均"],
    daylightBins.map((b) => [b.label, b.scores.length,
      b.scores.length ? meanFinite(b.scores).toFixed(1) : "—"]),
    { numCols: [1, 2] });
  html += `<div id="t5-bin" class="task-chart"></div>`;

  // Monthly bedtime std
  if (monthlyStd.length >= 2) {
    html += `<h3>📈 你每月作息有多穩定</h3>`;
    html += `<p class="muted">柱子越短 = 作息越固定。綠色 = 很穩、橘色 = 略亂、紅色 = 很亂。</p>`;
    html += `<div id="t5-stab" class="task-chart"></div>`;
  }

  // Weekend vs weekday — pick top 2-3 significant differences and show as plain text
  html += `<h3>📅 你的「週末恢復效應」存在嗎？</h3>`;
  const sigWk = wkRows.filter((r) => Number.isFinite(r.t.p) && r.t.p < 0.05);
  if (!sigWk.length) {
    html += `<p class="muted">看不出明顯的週末差別——你週末跟平日的身體訊號差不多。</p>`;
  } else {
    const lines = sigWk.slice(0, 4).map((r) => {
      const diff = r.wkndMean - r.wkdyMean;
      const goodSign = r.higherBetter ? diff > 0 : diff < 0;
      const wkndDesc = goodSign ? "比較好" : "比較差";
      return `<li><strong>${r.label}</strong>：週末${wkndDesc}（差距 ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}${r.unit}）</li>`;
    });
    const goodCount = sigWk.filter((r) => {
      const d = r.wkndMean - r.wkdyMean;
      return r.higherBetter ? d > 0 : d < 0;
    }).length;
    const overallGood = goodCount > sigWk.length / 2;
    html += callout(overallGood ? "good" : "low",
      `<strong>${overallGood ? "週末確實有恢復效應 ✓" : "週末沒有恢復到，反而更差"}</strong>` +
      `<ul style="margin: 6px 0 0 0; padding-left: 1.2em;">${lines.join("")}</ul>`);
  }
  html += `<details style="margin-top:8px;"><summary class="muted" style="cursor:pointer; font-size:0.85rem;">想看完整數字</summary>`;
  const wkTableRows = wkRows.map((r) => {
    const diff = r.wkndMean - r.wkdyMean;
    const goodSign = Number.isFinite(diff) && (r.higherBetter ? diff > 0 : diff < 0);
    const dirText = Number.isFinite(diff) ? (diff >= 0 ? "+" : "") + diff.toFixed(2) + r.unit : "—";
    return [
      r.label,
      Number.isFinite(r.wkdyMean) ? r.wkdyMean.toFixed(2) + r.unit : "—",
      Number.isFinite(r.wkndMean) ? r.wkndMean.toFixed(2) + r.unit : "—",
      `<span style="color:${goodSign ? 'var(--good)' : 'var(--bad)'}">${dirText}</span>`,
    ];
  });
  html += tableHtml(["指標", "平日均", "週末均", "週末 vs 平日"], wkTableRows, { numCols: [1, 2, 3] });
  html += `</details>`;

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

// Carry-forward variant: for a given day, look back up to `lookback` days for
// the latest finite value of each component. Lets today's breakdown show
// "RHR was 68 bpm two days ago" rather than just "no data" when today's
// specific reading is missing. Returns { components, stale } where stale[k]
// is the lag in days (0 if today, 1+ if pulled from earlier).
function readinessComponentsCarryForward(frame, idx, lookback = 7) {
  const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lookbackStart = Math.max(0, idx - lookback);
  function latestFor(key) {
    for (let i = idx; i >= lookbackStart; i--) {
      const v = frame.rows[i][key];
      if (Number.isFinite(v)) return { v, idx: i };
    }
    return null;
  }
  const map = {
    hrv:   { key: "hrv_zscore30",                 transform: (v) => clip(v, -2, 2) },
    rhr:   { key: "resting_hr_zscore30",          transform: (v) => clip(-v, -2, 2) },
    sleep: { key: "sleep_score",                  transform: (v) => (v - 70) / 15 },
    resp:  { key: "respiratory_zscore30",         transform: (v) => clip(-v, -2, 2) },
    temp:  { key: "wrist_temp_delta_c_zscore30",  transform: (v) => clip(-Math.abs(v), -2, 0) },
  };
  const components = {};
  const stale = {};
  for (const [k, m] of Object.entries(map)) {
    const r = latestFor(m.key);
    if (r) {
      components[k] = m.transform(r.v);
      if (r.idx !== idx) stale[k] = idx - r.idx;
    }
  }
  return { components, stale };
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

  // Carry-forward components for today's display (handles cases where a
  // specific indicator's reading is missing on the chosen "today" but was
  // present a couple days ago — happens often with sparsely-sampled data
  // like resting_hr or HRV from non-daily wear).
  const carry = readinessComponentsCarryForward(frame, todayIdx, 7);
  // Recompute spec score using the carry-forward components so the hero,
  // breakdown table, and "today's driver" all match.
  const specScoreCarry = aggregateReadiness(carry.components, READINESS_WEIGHTS.spec);
  const specForHero = Number.isFinite(specScoreCarry) ? specScoreCarry : today.spec;
  const todayClass = readinessClassFromValue(specForHero);
  const todayComponentCount = Object.keys(carry.components).length;

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

  // Dominant driver today (using carry-forward components so a missing-today
  // signal that exists 2 days ago can still be the dominant driver).
  const todayContribs = [];
  for (const k of ["hrv", "rhr", "sleep", "resp", "temp"]) {
    if (k in carry.components) {
      todayContribs.push({
        key: k, label: COMPONENT_LABEL[k],
        value: carry.components[k],
        contribution: READINESS_WEIGHTS.spec[k] * carry.components[k],
        staleDays: carry.stale[k] || 0,
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
  let html = `<h2 class="task-title">✅ 任務 6：今日身體分數</h2>`;
  html += `<p class="task-intro">把心跳變化、靜息心率、睡眠分數、呼吸、手腕體溫綜合起來，給今天的身體一個 0-100 分。回答最簡單的問題：「今天可以硬操嗎？可以做重要決定嗎？」</p>`;

  // Hero today's score
  html += `<div class="readiness-hero status-${todayClass.cls}">
    <div class="readiness-date muted">${todayDate}</div>
    <div class="readiness-value" style="color:${todayClass.color}">${Number.isFinite(specForHero) ? specForHero.toFixed(0) : "—"}<span class="readiness-scale"> / 100</span></div>
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

  // Today's interpretation: action sentence based on band + dominant driver
  const actionByBand = {
    good:  "今天可以硬操、做重要決定都沒問題。",
    fair:  "正常作息、不要排太重的事。",
    low:   "今天少操點、提早睡、避免關鍵決策。",
    alert: "今天強制休息、補水補眠。如果連續好幾天紅燈，要找原因。",
    empty: "資料不足。",
  };
  if (driver) {
    const isPushUp = driver.contribution >= 0;
    const drvSign = isPushUp ? "把分數拉高" : "把分數拉低";
    const drvClass = isPushUp ? "good" : "alert";
    const trendText = !Number.isFinite(trend) ? "" :
      trend > 2 ? "<br>最近一週整體還在進步中。" :
      trend < -2 ? "<br>⚠ 最近一週分數一直在下滑，建議減量、提早睡。" :
      "<br>最近一週分數很平穩。";
    html += callout(drvClass,
      `<strong>今天最影響分數的：${driver.label}</strong>${drvSign}。` +
      trendText +
      `<br>→ ${actionByBand[todayClass.cls] || ""}`);
  }

  // 365-day chart + threshold legend
  html += `<h3>📈 過去走勢</h3>`;
  html += `<p class="muted">綠線（75 分）以上 = 可以硬操、做重要決策。紅線（40 分）以下 = 建議休息、避免關鍵決策。</p>`;
  html += `<div id="t6-chart" class="task-chart"></div>`;
  html += `<p class="muted">在這個分析期間：🟢 綠燈 ${greens.length} 天 (${(greens.length / finiteIdx.length * 100).toFixed(0)}%)　·　🔴 紅燈 ${reds.length} 天 (${(reds.length / finiteIdx.length * 100).toFixed(0)}%)</p>`;

  // Component breakdown — plain language. Uses carry-forward so RHR / HRV
  // readings from up to 7 days ago still count, with a stale annotation.
  html += `<h3>🧩 今天分數的拆解</h3>`;
  html += `<p class="muted">每個項目對今天分數的影響。如果某項今天沒讀到，會用最近 7 天內最後一次的讀數（顯示「N 天前」）。</p>`;
  const compRows = ["hrv", "rhr", "sleep", "resp", "temp"].map((k) => {
    if (!(k in carry.components)) {
      return [COMPONENT_LABEL[k], "—", "<span class='muted'>最近 7 天沒讀到</span>"];
    }
    const c = carry.components[k];
    const contrib = READINESS_WEIGHTS.spec[k] * c;
    const word = c > 1.2  ? "🟢 比平常好很多" :
                 c > 0.3  ? "🟢 比平常好" :
                 c > -0.3 ? "🔵 跟平常差不多" :
                 c > -1.2 ? "🟡 比平常差" :
                            "🔴 比平常差很多";
    const stale = carry.stale[k] || 0;
    const staleNote = stale > 0 ? ` <span class="muted" style="font-size:0.8em;">（${stale} 天前）</span>` : "";
    const contribText = `<span style="color:${contrib >= 0 ? "var(--good)" : "var(--bad)"}">${contrib >= 0 ? "+" : ""}${contrib.toFixed(2)} 分</span>`;
    return [COMPONENT_LABEL[k], word + staleNote, contribText];
  });
  html += tableHtml(["項目", "今天表現", "對分數的影響"], compRows, { numCols: [2] });

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
      emptyState("資料量太少，至少需要 30 天讓 baseline 形成。");
    return;
  }

  // Required (always): respiratory z-score
  // Optional: wrist_temp_delta_c_zscore30 (Apple Watch Series 8+).
  // Without temp we fall back to "呼吸 + 心跳訊號" dual mode instead of
  // "呼吸 + 體溫" — looser but still actionable.
  const respZ = columnValues(frame, "respiratory_zscore30");
  const hrvZ = columnValues(frame, "hrv_zscore30");
  const rhrZ = columnValues(frame, "resting_hr_zscore30");
  const hasResp = respZ.some(Number.isFinite);
  const hasHrv = hrvZ.some(Number.isFinite);
  const hasRhr = rhrZ.some(Number.isFinite);

  if (!hasResp) {
    container.innerHTML = `<h2 class="task-title">🤒 任務 7：生病早警</h2>` +
      callout("warn",
        `<strong>⚠ 缺少呼吸頻率資料</strong><br>` +
        `這個分頁需要至少呼吸頻率 30 天的 baseline。請確認 Apple Watch 睡眠時有戴。`);
    return;
  }
  if (!hasHrv && !hasRhr) {
    container.innerHTML = `<h2 class="task-title">🤒 任務 7：生病早警</h2>` +
      callout("warn",
        `<strong>⚠ 缺少 HRV 或靜息心率</strong><br>` +
        `要判斷「警戒後是否真的進入發病期」需要其中一個指標。`);
    return;
  }

  const hasWristTemp = frame.columns.includes("wrist_temp_delta_c_zscore30") &&
    columnValues(frame, "wrist_temp_delta_c_zscore30").some(Number.isFinite);
  const tempZ = hasWristTemp ? columnValues(frame, "wrist_temp_delta_c_zscore30") : null;
  const detectionMode = hasWristTemp ? "temp" : "recovery";

  // 1. Warning days
  //    Mode 1 (preferred — Apple Watch Series 8+): respiratory_z > 1 AND wrist_temp_z > 1
  //    Mode 2 (fallback when no wrist temp): respiratory_z > 1 AND
  //                                          (HRV_z < -1 OR RHR_z > +1)
  //    Fallback is looser but still produces actionable signals.
  const warningDays = [];
  for (let i = 0; i < frame.rows.length; i++) {
    if (!Number.isFinite(respZ[i]) || respZ[i] <= 1) continue;
    if (hasWristTemp) {
      if (Number.isFinite(tempZ[i]) && tempZ[i] > 1) {
        warningDays.push({ idx: i, date: frame.rows[i].date, respZ: respZ[i], tempZ: tempZ[i] });
      }
    } else {
      const rhrSig = Number.isFinite(rhrZ[i]) && rhrZ[i] > 1;
      const hrvSig = Number.isFinite(hrvZ[i]) && hrvZ[i] < -1;
      if (rhrSig || hrvSig) {
        warningDays.push({
          idx: i, date: frame.rows[i].date,
          respZ: respZ[i], rhrZ: rhrZ[i], hrvZ: hrvZ[i],
        });
      }
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

  // Today's row + status
  let todayIdx = -1;
  for (let i = frame.rows.length - 1; i >= 0; i--) {
    if (Number.isFinite(respZ[i])) { todayIdx = i; break; }
  }
  let isTodayWarning = false;
  if (todayIdx >= 0 && respZ[todayIdx] > 1) {
    if (hasWristTemp) {
      isTodayWarning = Number.isFinite(tempZ[todayIdx]) && tempZ[todayIdx] > 1;
    } else {
      const rhrSig = Number.isFinite(rhrZ[todayIdx]) && rhrZ[todayIdx] > 1;
      const hrvSig = Number.isFinite(hrvZ[todayIdx]) && hrvZ[todayIdx] < -1;
      isTodayWarning = rhrSig || hrvSig;
    }
  }

  // Recent 14 days warning count (for context — "最近常常警戒嗎")
  const recent14WarningCount = warningDays.filter((w) => w.idx >= frame.rows.length - 14).length;

  // ---- Render ----
  let html = `<h2 class="task-title">🤒 任務 7：生病早警</h2>`;
  html += `<p class="task-intro">${
    hasWristTemp
      ? "結合你的呼吸頻率 + 手腕體溫，找「比身體感覺到生病早 1-2 天」的訊號。"
      : "你的 Apple Watch 沒有體溫資料（需要 Series 8+），改用「呼吸 + HRV/心率」雙訊號替代——較寬鬆但仍能抓到變化。"
  }</p>`;

  // Top verdict
  let verdict;
  if (todayIdx < 0) {
    verdict = { cls: "empty", emoji: "⚪", headline: "今日沒資料",
      detail: "需要呼吸頻率讀取才能判斷。" };
  } else if (isTodayWarning) {
    const subSignals = [];
    subSignals.push(`呼吸頻率比平常高（${respZ[todayIdx].toFixed(2)}σ）`);
    if (hasWristTemp && Number.isFinite(tempZ[todayIdx]))
      subSignals.push(`手腕體溫比平常高（${tempZ[todayIdx].toFixed(2)}σ）`);
    if (!hasWristTemp && Number.isFinite(rhrZ[todayIdx]) && rhrZ[todayIdx] > 1)
      subSignals.push(`靜息心率比平常高（${rhrZ[todayIdx].toFixed(2)}σ）`);
    if (!hasWristTemp && Number.isFinite(hrvZ[todayIdx]) && hrvZ[todayIdx] < -1)
      subSignals.push(`HRV 比平常低（${hrvZ[todayIdx].toFixed(2)}σ）`);
    verdict = {
      cls: "alert", emoji: "🔴",
      headline: "今天身體有發病前兆",
      detail: `${subSignals.join("、")}。這種訊號常常比你自己感覺到不舒服早 1-2 天。`,
      action: "減少行程、早點睡、多喝水。如果接下來 2-3 天 HRV 還是低、靜息心率還是高，大概率正在進入發病期。",
    };
  } else {
    verdict = {
      cls: "good", emoji: "🟢",
      headline: "今天沒有發病前兆",
      detail: hasWristTemp
        ? "呼吸頻率和手腕體溫都在你的正常範圍內。"
        : "呼吸頻率正常，HRV / 心率也沒明顯偏離。",
      action: "正常作息就好。",
    };
  }
  html += verdictPanel(verdict);

  // Body effect explanation
  if (isTodayWarning) {
    html += `<h3>💡 這個訊號代表什麼</h3>`;
    html += `<div class="effects-list">`;
    html += `<div class="effect-item bad">
      <div class="effect-title">⚠ 你的身體已經在打仗了</div>
      <div class="effect-body">呼吸頻率上升 + ${hasWristTemp ? "體溫上升" : "心率不正常"} 是免疫系統開始反應的訊號，比鼻塞 / 喉嚨痛 / 發燒早 1-2 天出現。可能的原因：感冒 / 流感前期、過敏、發炎、過度疲勞、月經週期、或最近喝太多酒 / 壓力大。</div>
    </div>`;
    html += `<div class="effect-item bad">
      <div class="effect-title">⚠ 接下來 2-3 天可能會：</div>
      <div class="effect-body">頭痛、肌肉痠痛、想睡、運動表現掉一半、決策變慢、情緒不穩。建議今晚減少社交、早點睡，明天起再觀察。</div>
    </div>`;
    html += `</div>`;
  }

  // Recent 14 days context
  html += `<h3>📊 最近 14 天概覽</h3>`;
  if (recent14WarningCount === 0) {
    html += `<p class="muted">最近 14 天沒有警戒日，身體狀態穩定。</p>`;
  } else if (recent14WarningCount <= 2) {
    html += callout("info", `最近 14 天有 <strong>${recent14WarningCount}</strong> 天警戒——可能是壓力 / 月經週期 / 短暫疲勞造成的雜訊，未必真的會生病。`);
  } else {
    html += callout("low", `最近 14 天有 <strong>${recent14WarningCount}</strong> 天警戒，比一般人多。可能在累積過勞或免疫力長期偏低，建議檢視最近的睡眠、運動量、飲食。`);
  }

  // Optional details: power user disclosure
  html += `<details style="margin-top:14px;"><summary class="muted" style="cursor:pointer; font-size:0.85rem;">想看歷史紀錄（共 ${warningDays.length} 個警戒日，${onsetEvents.length} 次發病事件）</summary>`;
  if (warningDays.length) {
    const outcomeMap = {
      onset:   { color: "var(--bad)",  text: (n) => `✗ 進展為發病（${n} 天連續異常）` },
      partial: { color: "var(--warn)", text: (n) => `△ 部分異常（${n} 天）` },
      none:    { color: "var(--good)", text: () => "✓ 未進展" },
      ongoing: { color: "var(--info)", text: () => "… 觀察中" },
    };
    const rows = warningDays.slice().reverse().slice(0, 30).map((w) => {
      const o = outcomeMap[w.outcome];
      return [
        w.date,
        `<span style="color:${o.color}">${o.text(w.postRun)}</span>`,
      ];
    });
    html += tableHtml(["警戒日", "後續結果"], rows, {});
  }
  if (Number.isFinite(sensitivity)) {
    html += `<p class="muted" style="margin-top:8px;">對你的歷史資料，這個早警系統的命中率是 <strong>${(sensitivity * 100).toFixed(0)}%</strong>（${warnedEvents} / ${onsetEvents.length} 次真實發病有在 1-3 天前先觸發）。</p>`;
  }
  html += `</details>`;

  container.innerHTML = html;
}
