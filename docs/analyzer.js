// Cross-dimensional analysis: Spearman correlation, lagged correlation,
// rolling-baseline anomaly detection, and Chinese narrative insights.
import { columnValues } from "./aggregator.js";

export const METRIC_LABELS = {
  steps: "步數",
  active_energy: "活動消耗",
  distance: "步行距離",
  flights: "爬樓層",
  hr: "平均心率",
  resting_hr: "靜息心率",
  walking_hr: "步行心率",
  hrv: "HRV",
  spo2: "血氧 (日均)",
  spo2_sleep_min: "睡眠期間最低血氧",
  respiratory: "呼吸頻率",
  body_temp: "體溫",
  vo2max: "VO2 Max",
  sleep_hours: "睡眠時數",
  sleep_deep_minutes: "深睡分鐘",
  sleep_rem_minutes: "REM 分鐘",
  sleep_awake_minutes: "夜間清醒分鐘",
  sleep_efficiency: "睡眠效率",
  bedtime_offset_min: "就寢時點 (18:00 後分鐘)",
};

export const DRIVERS_DEFAULT = ["sleep_hours", "sleep_efficiency", "steps", "active_energy", "bedtime_offset_min"];
export const RESPONSES_DEFAULT = ["resting_hr", "hrv", "spo2", "spo2_sleep_min", "sleep_efficiency", "sleep_hours"];

export function labelOf(col) { return METRIC_LABELS[col] || col; }

// ---- statistics ----------------------------------------------------------

function rankWithTies(arr) {
  const n = arr.length;
  const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && arr[idx[j + 1]] === arr[idx[i]]) j++;
    const r = (i + j) / 2 + 1; // 1-based average rank
    for (let k = i; k <= j; k++) ranks[idx[k]] = r;
    i = j + 1;
  }
  return ranks;
}

function pearson(x, y) {
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

// erf approximation (Abramowitz & Stegun 7.1.26); good to ~1.5e-7
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Two-sided p-value for Spearman r using normal approximation z = r * sqrt(n-1).
// Good enough for n >= 20. Returns 1 if degenerate.
function spearmanPValue(r, n) {
  if (!Number.isFinite(r) || n < 4) return 1;
  const z = r * Math.sqrt(n - 1);
  return Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
}

export function spearman(x, y) {
  const n = x.length;
  const xs = [], ys = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) {
      xs.push(x[i]); ys.push(y[i]);
    }
  }
  if (xs.length < 4) return { r: NaN, p: 1, n: xs.length };
  const r = pearson(rankWithTies(xs), rankWithTies(ys));
  return { r, p: spearmanPValue(r, xs.length), n: xs.length };
}

// ---- analysis primitives -------------------------------------------------

export function analyzableColumns(frame, minObs = 14) {
  return frame.columns.filter((c) => {
    const vals = columnValues(frame, c);
    let n = 0;
    for (const v of vals) if (Number.isFinite(v)) n++;
    return n >= minObs;
  });
}

export function correlationMatrix(frame, cols) {
  const data = {};
  for (const c of cols) data[c] = columnValues(frame, c);
  const matrix = cols.map(() => new Array(cols.length).fill(NaN));
  for (let i = 0; i < cols.length; i++) {
    for (let j = 0; j < cols.length; j++) {
      if (i === j) { matrix[i][j] = 1; continue; }
      if (j < i) { matrix[i][j] = matrix[j][i]; continue; }
      matrix[i][j] = spearman(data[cols[i]], data[cols[j]]).r;
    }
  }
  return { cols, matrix };
}

function shifted(arr, lag) {
  // shift response by `lag`: positive lag = response measured `lag` days after driver
  // we align driver[i] with response[i + lag]
  const out = new Array(arr.length).fill(NaN);
  for (let i = 0; i < arr.length; i++) {
    const j = i + lag;
    out[i] = (j >= 0 && j < arr.length) ? arr[j] : NaN;
  }
  return out;
}

export function laggedCorrelations(frame, drivers, responses, lags, minObs = 14) {
  const out = [];
  for (const d of drivers) {
    if (!frame.columns.includes(d)) continue;
    const dx = columnValues(frame, d);
    for (const r of responses) {
      if (!frame.columns.includes(r) || r === d) continue;
      const ry = columnValues(frame, r);
      for (const lag of lags) {
        const shifted_y = shifted(ry, lag);
        const { r: rho, p, n } = spearman(dx, shifted_y);
        if (!Number.isFinite(rho) || n < minObs) continue;
        out.push({ driver: d, response: r, lag, r: rho, p, n });
      }
    }
  }
  out.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  return out;
}

export function detectAnomalies(frame, sigma = 2.0, baseline = 28) {
  const anomalies = [];
  for (const col of frame.columns) {
    const vals = columnValues(frame, col);
    // rolling mean/std using only finite values within the trailing window
    for (let i = baseline; i < vals.length; i++) {
      const v = vals[i];
      if (!Number.isFinite(v)) continue;
      let n = 0, s = 0, ss = 0;
      for (let j = Math.max(0, i - baseline); j < i; j++) {
        const u = vals[j];
        if (Number.isFinite(u)) { n++; s += u; ss += u * u; }
      }
      if (n < Math.floor(baseline / 2)) continue;
      const mean = s / n;
      const variance = Math.max(0, ss / n - mean * mean);
      const sd = Math.sqrt(variance);
      if (sd === 0) continue;
      const z = (v - mean) / sd;
      if (Math.abs(z) >= sigma) {
        anomalies.push({ date: frame.rows[i].date, metric: col, value: v, baseline_mean: mean, z });
      }
    }
  }
  anomalies.sort((a, b) => (a.date < b.date ? 1 : -1));
  return anomalies;
}

// ---- insights ------------------------------------------------------------

function meanFinite(arr) {
  let n = 0, s = 0;
  for (const v of arr) if (Number.isFinite(v)) { n++; s += v; }
  return n ? s / n : NaN;
}

function trendChange(values, recent = 7, prior = 21) {
  // Find last `recent` finite samples and the prior `prior` samples before that
  const finite = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) finite.push(values[i]);
  if (finite.length < recent + 5) return null;
  const recentArr = finite.slice(-recent);
  const start = Math.max(0, finite.length - recent - prior);
  const priorArr = finite.slice(start, finite.length - recent);
  if (recentArr.length < Math.max(3, Math.floor(recent / 2))) return null;
  if (priorArr.length < Math.max(5, Math.floor(prior / 3))) return null;
  return { recent: meanFinite(recentArr), prior: meanFinite(priorArr) };
}

const WATCH = [
  ["resting_hr",       "higher_is_worse"],
  ["hrv",              "higher_is_better"],
  ["sleep_hours",      "higher_is_better"],
  ["sleep_efficiency", "higher_is_better"],
  ["spo2",             "higher_is_better"],
  ["spo2_sleep_min",   "higher_is_better"],
  ["steps",            "higher_is_better"],
  ["respiratory",      "neutral"],
  ["body_temp",        "neutral"],
];

export function generateInsights(frame) {
  const insights = [];
  // 1. Trend shifts
  for (const [col, dir] of WATCH) {
    if (!frame.columns.includes(col)) continue;
    const ch = trendChange(columnValues(frame, col));
    if (!ch || !Number.isFinite(ch.prior) || ch.prior === 0) continue;
    const deltaPct = (ch.recent - ch.prior) / Math.abs(ch.prior) * 100;
    if (Math.abs(deltaPct) < 5) continue;
    const verb = deltaPct > 0 ? "上升" : "下降";
    let severity = "info";
    const bad = (dir === "higher_is_worse" && deltaPct > 5) ||
                (dir === "higher_is_better" && deltaPct < -5);
    if (bad) severity = Math.abs(deltaPct) < 15 ? "watch" : "alert";
    insights.push({
      severity,
      title: `${labelOf(col)}近 7 天${verb} ${Math.abs(deltaPct).toFixed(1)}%`,
      detail: `近 7 天平均 ${ch.recent.toFixed(2)}，先前 21 天平均 ${ch.prior.toFixed(2)}。`,
    });
  }

  // 2. Top significant lagged correlations
  const drivers = DRIVERS_DEFAULT.filter((c) => frame.columns.includes(c));
  const responses = RESPONSES_DEFAULT.filter((c) => frame.columns.includes(c));
  const lc = laggedCorrelations(frame, drivers, responses, [0, 1, 2]);
  const significant = lc.filter((x) => x.p < 0.05 && Math.abs(x.r) >= 0.25);
  for (const row of significant.slice(0, 5)) {
    const lagText = row.lag === 0 ? "同一天" : `延後 ${row.lag} 天`;
    const sign = row.r > 0 ? "正相關" : "負相關";
    insights.push({
      severity: "info",
      title: `${labelOf(row.driver)} 與 ${labelOf(row.response)}（${lagText}）呈${sign} (r=${row.r >= 0 ? "+" : ""}${row.r.toFixed(2)})`,
      detail: `基於 ${row.n} 天樣本，p=${row.p.toFixed(3)}。可作為調整生活作息的參考訊號。`,
    });
  }

  // 3. Recent anomalies (last 14 days)
  const anom = detectAnomalies(frame);
  if (anom.length && frame.rows.length) {
    const lastDate = new Date(frame.rows[frame.rows.length - 1].date);
    const cutoff = new Date(lastDate);
    cutoff.setDate(cutoff.getDate() - 14);
    const recent = anom.filter((a) => new Date(a.date) >= cutoff).slice(0, 5);
    for (const a of recent) {
      const dir = a.z > 0 ? "高於" : "低於";
      const severity = Math.abs(a.z) < 3 ? "watch" : "alert";
      const md = a.date.slice(5);
      insights.push({
        severity,
        title: `${md} ${labelOf(a.metric)}異常 (${dir}基準 ${Math.abs(a.z).toFixed(1)}σ)`,
        detail: `當日 ${a.value.toFixed(2)}，前 28 天基準平均 ${a.baseline_mean.toFixed(2)}。`,
      });
    }
  }

  return insights;
}
