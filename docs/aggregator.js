// Build the daily wide frame from the streaming-aggregated parser output.
import { SUPPORTED_METRICS } from "./parser.js";

// Metrics that get a 30-day rolling baseline + z-score column. Phase 3
// Readiness/Environment scores read these baselines.
const BASELINE_METRICS = [
  "resting_hr", "hrv", "respiratory", "sleep_score", "spo2", "daylight",
  "walking_hr", "wrist_temp_delta_c",
];

// "date key" = local YYYY-MM-DD of a Date instance (used as map key)
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function* daysBetween(start, end) {
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const stop = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur <= stop) {
    yield dateKey(cur);
    cur.setDate(cur.getDate() + 1);
  }
}

// Reduce a streaming accumulator { sum, count, min, max, sumSq } to a single
// scalar per the spec's aggregation mode.
function finalizeAcc(acc, mode) {
  if (!acc || acc.count === 0) return undefined;
  if (mode === "sum") return acc.sum;
  if (mode === "min") return acc.min;
  if (mode === "max") return acc.max;
  return acc.sum / acc.count;  // mean (default)
}

const ASLEEP_STAGES = new Set(["Asleep", "AsleepCore", "AsleepDeep", "AsleepREM", "AsleepUnspecified"]);
const IN_BED_STAGES = new Set(["InBed"]);

function sleepDaily(sleep) {
  // Attribute each session to the date of its END timestamp (matches Apple Health UI).
  const byDate = new Map();
  for (const s of sleep) {
    const k = dateKey(s.end);
    let d = byDate.get(k);
    if (!d) {
      d = { asleepMin: 0, inBedMin: 0, deepMin: 0, remMin: 0, awakeMin: 0,
            sleepStart: null, sleepEnd: null };
      byDate.set(k, d);
    }
    const minutes = (s.end - s.start) / 60000;
    if (ASLEEP_STAGES.has(s.stage)) d.asleepMin += minutes;
    if (IN_BED_STAGES.has(s.stage)) d.inBedMin += minutes;
    if (s.stage === "AsleepDeep")   d.deepMin += minutes;
    if (s.stage === "AsleepREM")    d.remMin += minutes;
    if (s.stage === "Awake")        d.awakeMin += minutes;
    if (!d.sleepStart || s.start < d.sleepStart) d.sleepStart = s.start;
    if (!d.sleepEnd   || s.end   > d.sleepEnd)   d.sleepEnd = s.end;
  }
  return byDate;
}

// 0-100 sleep score: 50% duration vs 7.5h target + 25% deep ratio vs 20%
// + 25% REM ratio vs 25%. Mirrors the Python aggregator and parse_health.py.
function sleepScoreOf(asleepMin, deepMin, remMin) {
  const asleepH = asleepMin / 60;
  if (asleepH < 1) return null;
  const dur = Math.min(asleepH / 7.5, 1) * 50;
  const deepRatio = deepMin / asleepMin;
  const remRatio = remMin / asleepMin;
  const deep = Math.min(deepRatio / 0.20, 1) * 25;
  const rem  = Math.min(remRatio  / 0.25, 1) * 25;
  return Math.round((dur + deep + rem) * 10) / 10;
}

// Bedtime as minutes after 18:00 of the preceding evening (e.g. 23:30 → 330,
// 01:00 next morning → 420). Lets correlations treat bedtime as a scalar.
function bedtimeOffset(start) {
  if (!start) return null;
  const ref = new Date(start);
  ref.setHours(18, 0, 0, 0);
  if (start.getHours() < 18) ref.setDate(ref.getDate() - 1);
  return (start - ref) / 60000;
}

// Alternate bedtime form: 23:30 → 23.5, 01:30 → 25.5 (24+ for after-midnight).
// Matches scripts/parse_health.py canonical schema.
function bedtimeHour(start) {
  if (!start) return null;
  const h = start.getHours() + start.getMinutes() / 60;
  return Math.round((h < 12 ? h + 24 : h) * 100) / 100;
}

// SpO2 minimum among readings that fall inside any sleep session, attributed to
// the session's end-day.
function spo2DuringSleep(spo2Records, sleepRecords) {
  const sessions = sleepRecords
    .filter((s) => ASLEEP_STAGES.has(s.stage) || IN_BED_STAGES.has(s.stage))
    .sort((a, b) => a.start - b.start);
  if (!sessions.length || !spo2Records.length) return new Map();
  const out = new Map();
  let i = 0;
  for (const r of spo2Records) {
    while (i < sessions.length && sessions[i].end < r.start) i++;
    for (const j of [i - 1, i]) {
      if (j < 0 || j >= sessions.length) continue;
      const s = sessions[j];
      if (s.start <= r.start && r.start <= s.end) {
        const k = dateKey(s.end);
        const cur = out.get(k);
        out.set(k, cur === undefined ? r.value : Math.min(cur, r.value));
        break;
      }
    }
  }
  return out;
}

// Add `${col}_baseline30` and `${col}_zscore30` to the rows in-place. window=30,
// minPeriods=7 mirrors the Python aggregator so the two pipelines produce
// comparable Phase 3 inputs.
function attachBaselines(rows, columns, baselineCols, window = 30, minPeriods = 7) {
  for (const col of baselineCols) {
    if (!columns.includes(col)) continue;
    const baseKey = `${col}_baseline30`;
    const zKey = `${col}_zscore30`;
    columns.push(baseKey, zKey);
    for (let i = 0; i < rows.length; i++) {
      const lo = Math.max(0, i - window + 1);
      let n = 0, sum = 0, ss = 0;
      for (let j = lo; j <= i; j++) {
        const v = rows[j][col];
        if (Number.isFinite(v)) { n++; sum += v; ss += v * v; }
      }
      if (n < minPeriods) {
        rows[i][baseKey] = NaN;
        rows[i][zKey] = NaN;
        continue;
      }
      const mean = sum / n;
      // sample std (Bessel) to match pandas .std()
      const variance = n > 1 ? Math.max(0, (ss - n * mean * mean) / (n - 1)) : 0;
      const sd = Math.sqrt(variance);
      const v = rows[i][col];
      rows[i][baseKey] = mean;
      rows[i][zKey] = (Number.isFinite(v) && sd > 0) ? (v - mean) / sd : NaN;
    }
  }
}

export function buildDailyFrame(parsed) {
  // parsed.dailyAggs: Map<dateKey, Map<metricKey, {sum,count,min,max,sumSq}>>
  // parsed.sleep:     [{ start, end, stage, source }]
  // parsed.spo2Raw:   [{ start, value }]
  const cols = new Map(); // colKey -> Map<dateKey, value>
  const allDates = new Set();
  const dailyAggs = parsed.dailyAggs || new Map();

  // Walk the per-day accumulators and finalize each metric per its agg mode.
  // Same observable result as the old "iterate raw records, aggregate" pass,
  // but without ever holding the raw record arrays in memory.
  const presentMetrics = new Set();
  for (const [dKey, dayMap] of dailyAggs) {
    for (const mKey of dayMap.keys()) presentMetrics.add(mKey);
    allDates.add(dKey);
  }
  for (const spec of SUPPORTED_METRICS) {
    if (!presentMetrics.has(spec.key)) continue;
    const m = new Map();
    for (const [dKey, dayMap] of dailyAggs) {
      const acc = dayMap.get(spec.key);
      const v = finalizeAcc(acc, spec.agg);
      if (v !== undefined) m.set(dKey, v);
    }
    if (m.size) cols.set(spec.key, m);
  }

  // HR derivations: min / max / std / samples come straight from the HR
  // accumulator (count, min, max, sumSq are already there from streaming).
  if (presentMetrics.has("hr")) {
    const minM = new Map(), maxM = new Map(), stdM = new Map(), nM = new Map();
    for (const [dKey, dayMap] of dailyAggs) {
      const acc = dayMap.get("hr");
      if (!acc || acc.count === 0) continue;
      const mean = acc.sum / acc.count;
      const variance = acc.count > 1
        ? Math.max(0, (acc.sumSq - acc.count * mean * mean) / (acc.count - 1))
        : 0;
      minM.set(dKey, acc.min);
      maxM.set(dKey, acc.max);
      stdM.set(dKey, Math.sqrt(variance));
      nM.set(dKey, acc.count);
    }
    cols.set("heart_rate_min", minM);
    cols.set("heart_rate_max", maxM);
    cols.set("heart_rate_std", stdM);
    cols.set("heart_rate_samples", nM);
  }

  if (parsed.sleep && parsed.sleep.length) {
    const s = sleepDaily(parsed.sleep);
    const sleepHours = new Map();
    const deep = new Map(), rem = new Map(), awake = new Map();
    const eff = new Map(), bed = new Map(), bedHr = new Map(), score = new Map();
    for (const [k, d] of s) {
      const minutes = d.asleepMin || d.inBedMin;
      sleepHours.set(k, minutes / 60);
      deep.set(k, d.deepMin);
      rem.set(k, d.remMin);
      awake.set(k, d.awakeMin);
      if (d.inBedMin > 0) eff.set(k, d.asleepMin / d.inBedMin);
      const off = bedtimeOffset(d.sleepStart);
      if (off != null) bed.set(k, off);
      const bh = bedtimeHour(d.sleepStart);
      if (bh != null) bedHr.set(k, bh);
      const sc = sleepScoreOf(d.asleepMin, d.deepMin, d.remMin);
      if (sc != null) score.set(k, sc);
      allDates.add(k);
    }
    cols.set("sleep_hours", sleepHours);
    cols.set("sleep_deep_minutes", deep);
    cols.set("sleep_rem_minutes", rem);
    cols.set("sleep_awake_minutes", awake);
    cols.set("sleep_efficiency", eff);
    cols.set("bedtime_offset_min", bed);
    cols.set("bedtime_hour", bedHr);
    cols.set("sleep_score", score);

    // SpO2 sleep min: uses spo2Raw (kept full from streaming, small set) and
    // the sleep windows. Interval join — see spo2DuringSleep below.
    if (parsed.spo2Raw && parsed.spo2Raw.length) {
      const sm = spo2DuringSleep(parsed.spo2Raw, parsed.sleep);
      if (sm.size) {
        cols.set("spo2_sleep_min", sm);
        for (const k of sm.keys()) allDates.add(k);
      }
    }
  }

  // Build dense daily frame: one row per calendar day in [min, max], NaN-fill.
  const dates = [...allDates].sort();
  if (!dates.length) return { dates: [], rows: [], columns: [] };
  const minDate = new Date(dates[0]);
  const maxDate = new Date(dates[dates.length - 1]);
  const denseDates = [...daysBetween(minDate, maxDate)];

  const columns = [...cols.keys()];
  const rows = denseDates.map((dk) => {
    const row = { date: dk };
    for (const c of columns) {
      const v = cols.get(c).get(dk);
      row[c] = v === undefined ? NaN : v;
    }
    return row;
  });

  attachBaselines(rows, columns, BASELINE_METRICS);

  return { dates: denseDates, rows, columns };
}

// Convenience: extract a column as an array aligned with rows
export function columnValues(frame, col) {
  return frame.rows.map((r) => r[col]);
}

// Rolling mean ignoring NaN; window is centered-trailing (right-aligned).
export function rollingMean(values, window) {
  const out = new Array(values.length).fill(NaN);
  const minPeriods = Math.max(2, Math.floor(window / 2));
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - window + 1);
    let sum = 0, n = 0;
    for (let j = lo; j <= i; j++) {
      const v = values[j];
      if (Number.isFinite(v)) { sum += v; n++; }
    }
    out[i] = n >= minPeriods ? sum / n : NaN;
  }
  return out;
}
