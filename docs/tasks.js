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

export function renderTask2(frame, container) {
  container.innerHTML = PENDING_NOTE(2, "🔋 任務 2：核心 Readiness 三角");
}
export function renderTask3(frame, container) {
  container.innerHTML = PENDING_NOTE(3, "💤 任務 3：睡眠 → 隔日恢復");
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
