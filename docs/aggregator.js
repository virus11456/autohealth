// Roll per-record arrays into a daily frame.
import { SUPPORTED_METRICS } from "./parser.js";

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

function aggregate(records, mode) {
  const buckets = new Map();
  for (const r of records) {
    const k = dateKey(r.start);
    let b = buckets.get(k);
    if (!b) { b = { sum: 0, count: 0, min: Infinity, max: -Infinity }; buckets.set(k, b); }
    b.sum += r.value;
    b.count++;
    if (r.value < b.min) b.min = r.value;
    if (r.value > b.max) b.max = r.value;
  }
  const out = new Map();
  for (const [k, b] of buckets) {
    let v;
    if (mode === "sum")  v = b.sum;
    else if (mode === "min")  v = b.min;
    else if (mode === "max")  v = b.max;
    else                       v = b.sum / b.count;
    out.set(k, v);
  }
  return out;
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

// Bedtime as minutes after 18:00 of the preceding evening (e.g. 23:30 → 330,
// 01:00 next morning → 420). Lets correlations treat bedtime as a scalar.
function bedtimeOffset(start) {
  if (!start) return null;
  const ref = new Date(start);
  ref.setHours(18, 0, 0, 0);
  if (start.getHours() < 18) ref.setDate(ref.getDate() - 1);
  return (start - ref) / 60000;
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

export function buildDailyFrame(parsed) {
  const cols = new Map(); // colKey -> Map<dateKey, value>
  const allDates = new Set();

  for (const spec of SUPPORTED_METRICS) {
    const records = parsed.quantities?.[spec.key];
    if (!records || !records.length) continue;
    const m = aggregate(records, spec.agg);
    cols.set(spec.key, m);
    for (const k of m.keys()) allDates.add(k);
  }

  if (parsed.sleep && parsed.sleep.length) {
    const s = sleepDaily(parsed.sleep);
    const sleepHours = new Map();
    const deep = new Map(), rem = new Map(), awake = new Map();
    const eff = new Map(), bed = new Map();
    for (const [k, d] of s) {
      const minutes = d.asleepMin || d.inBedMin;
      sleepHours.set(k, minutes / 60);
      deep.set(k, d.deepMin);
      rem.set(k, d.remMin);
      awake.set(k, d.awakeMin);
      if (d.inBedMin > 0) eff.set(k, d.asleepMin / d.inBedMin);
      const off = bedtimeOffset(d.sleepStart);
      if (off != null) bed.set(k, off);
      allDates.add(k);
    }
    cols.set("sleep_hours", sleepHours);
    cols.set("sleep_deep_minutes", deep);
    cols.set("sleep_rem_minutes", rem);
    cols.set("sleep_awake_minutes", awake);
    cols.set("sleep_efficiency", eff);
    cols.set("bedtime_offset_min", bed);

    if (parsed.quantities?.spo2) {
      const sm = spo2DuringSleep(parsed.quantities.spo2, parsed.sleep);
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
