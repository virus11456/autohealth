// Scoring engine: turns the daily frame + intraday buckets into the
// consumer-facing numbers (stress score, real-time stress timeline, Body
// Battery, sleep score, recovery, HRV status, daily alerts).
//
// All scores are 0–100 and explained in the UI. The heuristics are inspired by
// the published behaviour of HRV/stress wearables: stress rises when HRV drops
// and resting heart rate rises relative to the user's own rolling baseline;
// Body Battery charges while asleep and drains with stress and exercise.
//
// Nothing here is medical advice — see README.

import { columnValues } from "./aggregator.js";

export const STRESS_LEVELS = [
  { max: 25,  key: "relaxed",  label: "放鬆", color: "var(--lv-relaxed)",  emoji: "😌" },
  { max: 50,  key: "balanced", label: "平衡", color: "var(--lv-balanced)", emoji: "🙂" },
  { max: 75,  key: "tense",    label: "緊繃", color: "var(--lv-tense)",    emoji: "😬" },
  { max: 100, key: "high",     label: "高壓", color: "var(--lv-high)",     emoji: "😣" },
];

export function stressLevel(score) {
  if (!Number.isFinite(score)) return { key: "none", label: "無資料", color: "var(--muted)", emoji: "😶" };
  for (const l of STRESS_LEVELS) if (score <= l.max) return l;
  return STRESS_LEVELS[STRESS_LEVELS.length - 1];
}

export const DEFAULT_SETTINGS = {
  stepsGoal: 8000,
  sleepGoalHours: 7.5,
  bedtimeGoal: "23:30",   // HH:MM
  baselineDays: 28,
  theme: "auto",
};

// ---- small stats helpers --------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (arr) => arr.filter((v) => Number.isFinite(v));

export function median(arr) {
  const a = finite(arr).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mad(arr, med) {
  const a = finite(arr);
  if (a.length < 4) return NaN;
  const m = Number.isFinite(med) ? med : median(a);
  return 1.4826 * median(a.map((v) => Math.abs(v - m)));
}

function mean(arr) {
  const a = finite(arr);
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
}

// Baseline (median) of the trailing `window` days before index i, excluding i.
function trailingBaseline(values, i, window, minObs = 5) {
  const slice = values.slice(Math.max(0, i - window), i);
  const f = finite(slice);
  if (f.length < minObs) {
    // bootstrap from whatever we have around (first weeks of data)
    const wide = finite(values.slice(0, Math.min(values.length, Math.max(i + 1, window))));
    if (wide.length < 3) return { med: NaN, spread: NaN, n: wide.length };
    return { med: median(wide), spread: mad(wide), n: wide.length, bootstrap: true };
  }
  return { med: median(f), spread: mad(f, median(f)), n: f.length };
}

// Piecewise-linear interpolation through [x, y] points (sorted by x).
function piecewise(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

function hhmmToOffset(hhmm) {
  // minutes after 18:00 (same convention as bedtime_offset_min)
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return 330;
  let mins = parseInt(m[1]) * 60 + parseInt(m[2]);
  mins -= 18 * 60;
  if (mins < 0) mins += 24 * 60;
  return mins;
}

export function offsetToHHMM(off) {
  if (!Number.isFinite(off)) return "—";
  let mins = Math.round(off) + 18 * 60;
  mins = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// ---- sleep score ----------------------------------------------------------

export function sleepScoreFor(row, bedtimeBaseline) {
  const parts = [];
  const hours = row.sleep_hours;
  if (!Number.isFinite(hours) || hours <= 0) return { score: NaN, parts: [] };

  const dur = piecewise(hours, [[2, 5], [4, 20], [5, 45], [6, 70], [7, 90], [7.5, 100], [9.5, 100], [10.5, 85], [12, 70]]);
  parts.push({ key: "duration", label: "睡眠時數", score: dur, weight: 0.55, text: `${hours.toFixed(1)} 小時` });

  if (Number.isFinite(row.sleep_efficiency)) {
    const eff = clamp((row.sleep_efficiency - 0.75) / 0.2, 0, 1) * 100;
    parts.push({ key: "efficiency", label: "睡眠效率", score: eff, weight: 0.15, text: `${(row.sleep_efficiency * 100).toFixed(0)}%` });
  }

  const totalMin = hours * 60;
  if (Number.isFinite(row.sleep_deep_minutes) && Number.isFinite(row.sleep_rem_minutes) &&
      row.sleep_deep_minutes + row.sleep_rem_minutes > 0) {
    const deepPct = row.sleep_deep_minutes / totalMin;
    const remPct = row.sleep_rem_minutes / totalMin;
    const deep = piecewise(deepPct, [[0.03, 20], [0.08, 60], [0.13, 100], [0.25, 100], [0.35, 70]]);
    const rem = piecewise(remPct, [[0.05, 20], [0.12, 60], [0.18, 100], [0.30, 100], [0.40, 70]]);
    parts.push({ key: "stages", label: "深睡 / REM", score: (deep + rem) / 2, weight: 0.15,
      text: `深睡 ${(deepPct * 100).toFixed(0)}% · REM ${(remPct * 100).toFixed(0)}%` });
  }

  if (Number.isFinite(row.bedtime_offset_min) && Number.isFinite(bedtimeBaseline)) {
    const diff = Math.abs(row.bedtime_offset_min - bedtimeBaseline);
    const cons = piecewise(diff, [[0, 100], [30, 100], [60, 70], [90, 45], [120, 20], [180, 5]]);
    parts.push({ key: "consistency", label: "作息規律", score: cons, weight: 0.15,
      text: `${offsetToHHMM(row.bedtime_offset_min)} 就寢（平常 ${offsetToHHMM(bedtimeBaseline)}）` });
  }

  const wsum = parts.reduce((s, p) => s + p.weight, 0);
  let score = parts.reduce((s, p) => s + p.score * p.weight, 0) / wsum;
  // A short night can never be "good" no matter how efficient it was.
  score = Math.min(score, dur + 20);
  return { score: clamp(score, 0, 100), parts };
}

// ---- intraday stress ------------------------------------------------------

function overlapMinutes(hourStartMs, intervals) {
  const hourEnd = hourStartMs + 3600e3;
  let total = 0;
  for (const [s, e] of intervals) {
    const lo = Math.max(s, hourStartMs), hi = Math.min(e, hourEnd);
    if (hi > lo) total += (hi - lo) / 60000;
  }
  return total;
}

function localMidnightMs(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

// Returns per-hour { state, stress, hr } for one day.
// state: "sleep" | "workout" | "awake" | "none"
export function intradayStress(dateKey, hourly, sleepIvs, workoutIvs, rhrRef, hrvRef) {
  const midnight = localMidnightMs(dateKey);
  const out = [];
  for (let h = 0; h < 24; h++) {
    const hs = midnight + h * 3600e3;
    const sleepMin = overlapMinutes(hs, sleepIvs);
    const workMin = overlapMinutes(hs, workoutIvs);
    const hr = hourly ? hourly.hr[h] : NaN;
    const hrv = hourly ? hourly.hrv[h] : NaN;
    let state = "none", stress = NaN;
    if (sleepMin >= 30) state = "sleep";
    else if (workMin >= 10) state = "workout";
    else if (Number.isFinite(hr)) state = "awake";

    if (state === "awake" && Number.isFinite(hr) && Number.isFinite(rhrRef)) {
      stress = 10 + (hr - rhrRef) * 2.2;
    } else if (state === "sleep" && Number.isFinite(hr) && Number.isFinite(rhrRef)) {
      stress = 5 + (hr - (rhrRef - 5)) * 2;
      stress = Math.min(stress, 60);
    }
    if (Number.isFinite(stress) && Number.isFinite(hrv) && Number.isFinite(hrvRef) && hrv > 0 && hrvRef > 0) {
      stress -= (Math.log(hrv / hrvRef) / 0.3) * 10;
    }
    if (Number.isFinite(stress)) stress = clamp(stress, 0, 100);
    out.push({ hour: h, state, stress, hr: Number.isFinite(hr) ? hr : NaN, sleepMin, workMin });
  }
  return out;
}

// ---- main ------------------------------------------------------------------

/**
 * @param dataset { frame, hourly, sleepIntervals, workouts }
 * @param settings DEFAULT_SETTINGS-like
 * @returns { days: ScoredDay[], byDate: {date: ScoredDay} }
 */
export function scoreDataset(dataset, settings = DEFAULT_SETTINGS) {
  const { frame } = dataset;
  const hourlyAll = dataset.hourly || {};
  const sleepAll = dataset.sleepIntervals || {};
  const workoutsByDate = {};
  for (const w of dataset.workouts || []) {
    (workoutsByDate[w.date] ||= []).push([w.start, w.end]);
    // workouts spanning midnight: also register on end day
    const endDay = new Date(w.end); const ek = `${endDay.getFullYear()}-${String(endDay.getMonth() + 1).padStart(2, "0")}-${String(endDay.getDate()).padStart(2, "0")}`;
    if (ek !== w.date) (workoutsByDate[ek] ||= []).push([w.start, w.end]);
  }

  const has = (c) => frame.columns.includes(c);
  const hrvCol = has("hrv") ? columnValues(frame, "hrv") : null;
  const rhrCol = has("resting_hr") ? columnValues(frame, "resting_hr") : null;
  const bedCol = has("bedtime_offset_min") ? columnValues(frame, "bedtime_offset_min") : null;
  const window = settings.baselineDays || 28;

  const days = [];
  let battery = 60; // initial state of charge
  let lastSleepQuality = 0.65;

  for (let i = 0; i < frame.rows.length; i++) {
    const row = frame.rows[i];
    const date = row.date;

    // --- baselines
    const hrvB = hrvCol ? trailingBaseline(hrvCol, i, window) : { med: NaN, spread: NaN };
    const rhrB = rhrCol ? trailingBaseline(rhrCol, i, window) : { med: NaN, spread: NaN };
    const bedB = bedCol ? trailingBaseline(bedCol, i, 14, 4) : { med: NaN };
    const hrvSpread = Number.isFinite(hrvB.spread) && hrvB.spread > 0 ? hrvB.spread / Math.max(1, hrvB.med) : 0.2;
    const rhrSpread = Number.isFinite(rhrB.spread) && rhrB.spread > 0 ? rhrB.spread : 2.5;

    const hrv = row.hrv, rhr = row.resting_hr;
    const zHrv = Number.isFinite(hrv) && Number.isFinite(hrvB.med) && hrv > 0 && hrvB.med > 0
      ? clamp(Math.log(hrv / hrvB.med) / Math.max(0.08, hrvSpread), -3, 3) : NaN;
    const zRhr = Number.isFinite(rhr) && Number.isFinite(rhrB.med)
      ? clamp((rhr - rhrB.med) / Math.max(1.5, rhrSpread), -3, 3) : NaN;

    // --- sleep
    const sleep = sleepScoreFor(row, bedB.med);
    if (Number.isFinite(sleep.score)) lastSleepQuality = sleep.score / 100;

    // --- intraday
    const rhrRef = Number.isFinite(rhr) ? rhr : rhrB.med;
    const hrvRef = Number.isFinite(hrvB.med) ? hrvB.med : hrv;
    const intraday = intradayStress(date, hourlyAll[date], sleepAll[date] || [], workoutsByDate[date] || [], rhrRef, hrvRef);
    const awakeStress = mean(intraday.filter((h) => h.state === "awake").map((h) => h.stress));
    const hasIntraday = intraday.some((h) => h.state !== "none");

    // --- daily stress score
    let stress = NaN;
    const comps = [];
    if (Number.isFinite(zHrv)) comps.push({ label: "HRV 相對基準", value: -zHrv * 14, text: `${hrv.toFixed(0)} ms（基準 ${hrvB.med.toFixed(0)}）` });
    if (Number.isFinite(zRhr)) comps.push({ label: "靜息心率相對基準", value: zRhr * 12, text: `${rhr.toFixed(0)} bpm（基準 ${rhrB.med.toFixed(0)}）` });
    if (Number.isFinite(awakeStress)) comps.push({ label: "日間心率負荷", value: (awakeStress - 40) * 0.3, text: `日間平均即時壓力 ${awakeStress.toFixed(0)}` });
    if (Number.isFinite(sleep.score)) comps.push({ label: "前晚睡眠", value: (60 - sleep.score) * 0.15, text: `睡眠分數 ${sleep.score.toFixed(0)}` });
    if (comps.length) {
      stress = clamp(45 + comps.reduce((s, c) => s + c.value, 0), 0, 100);
    }

    // --- recovery / readiness
    let recovery = NaN;
    {
      const parts = [];
      if (Number.isFinite(zHrv)) parts.push([clamp(50 + 22 * zHrv, 0, 100), 0.4]);
      if (Number.isFinite(zRhr)) parts.push([clamp(50 - 22 * zRhr, 0, 100), 0.25]);
      if (Number.isFinite(sleep.score)) parts.push([sleep.score, 0.35]);
      if (parts.length) {
        const w = parts.reduce((s, p) => s + p[1], 0);
        recovery = parts.reduce((s, p) => s + p[0] * p[1], 0) / w;
      }
    }

    // --- Body Battery simulation (hour by hour, continuous across days)
    const curve = new Array(24);
    const dailyStress = Number.isFinite(stress) ? stress : 45;
    let wakeLevel = NaN, lowest = Infinity, highest = -Infinity, lastKnown = NaN;
    let prevState = null;
    for (let h = 0; h < 24; h++) {
      const slot = intraday[h];
      let state = slot.state;
      if (state === "none") {
        // no sensor coverage this hour: assume typical pattern
        state = (h < 7 && !hasIntraday) || (slot.sleepMin >= 30) ? "sleep" : "awake";
        if (!hasIntraday && h >= 7) state = "awake";
      }
      let delta;
      if (state === "sleep") {
        const sleepStress = Number.isFinite(slot.stress) ? slot.stress : 20;
        delta = (4.5 + 3 * lastSleepQuality - 1.5 * (sleepStress / 60)) * (slot.sleepMin > 0 ? Math.min(1, slot.sleepMin / 60) : 1);
      } else if (state === "workout") {
        delta = -(8 * Math.min(1, slot.workMin / 60)) - 1.2 * (1 - Math.min(1, slot.workMin / 60));
      } else {
        const s = Number.isFinite(slot.stress) ? slot.stress : dailyStress;
        delta = -(1.2 + 4.5 * (s / 100));
      }
      battery = clamp(battery + delta, 5, 100);
      curve[h] = Math.round(battery);
      if (prevState === "sleep" && state !== "sleep" && !Number.isFinite(wakeLevel)) wakeLevel = battery;
      if (battery < lowest) lowest = battery;
      if (battery > highest) highest = battery;
      if (slot.state !== "none") lastKnown = battery;
      prevState = state;
    }
    if (!Number.isFinite(wakeLevel)) wakeLevel = curve[7];

    // --- activity
    const activity = {
      steps: row.steps, energy: row.active_energy, distance: row.distance, flights: row.flights,
      stepsGoal: settings.stepsGoal,
      workouts: (dataset.workouts || []).filter((w) => w.date === date),
    };

    // --- HRV status (7d vs baseline)
    let hrvStatus = null;
    if (hrvCol) {
      const recent = mean(hrvCol.slice(Math.max(0, i - 6), i + 1));
      if (Number.isFinite(recent) && Number.isFinite(hrvB.med) && hrvB.med > 0) {
        const ratio = recent / hrvB.med;
        hrvStatus = {
          recent, baseline: hrvB.med, ratio,
          low: hrvB.med * (1 - hrvSpread), high: hrvB.med * (1 + hrvSpread),
          trend: ratio > 1.05 ? "up" : ratio < 0.95 ? "down" : "stable",
        };
      }
    }

    days.push({
      date, index: i,
      stress, stressLevel: stressLevel(stress), stressComponents: comps,
      hrv, hrvBaseline: hrvB.med, zHrv, hrvStatus,
      rhr, rhrBaseline: rhrB.med, zRhr, rhrSpread,
      sleep: { ...sleep, hours: row.sleep_hours, efficiency: row.sleep_efficiency,
        deep: row.sleep_deep_minutes, rem: row.sleep_rem_minutes, awake: row.sleep_awake_minutes,
        bedtime: row.bedtime_offset_min, bedtimeBaseline: bedB.med, spo2Min: row.spo2_sleep_min },
      recovery,
      battery: { curve, wake: Math.round(wakeLevel), low: Math.round(lowest), high: Math.round(highest),
        now: Number.isFinite(lastKnown) ? Math.round(lastKnown) : curve[23] },
      intraday, awakeStress, hasIntraday,
      activity,
      spo2: row.spo2, respiratory: row.respiratory, vo2max: row.vo2max, bodyTemp: row.body_temp,
    });
  }

  const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
  return { days, byDate };
}

// ---- alerts ("smart notifications" rendered as cards) ----------------------

export function dailyAlerts(day, prevDay, settings = DEFAULT_SETTINGS, isLatest = true) {
  const out = [];
  if (!day) return out;
  if (Number.isFinite(day.rhr) && Number.isFinite(day.rhrBaseline)) {
    const thr = Math.max(5, 2 * (day.rhrSpread || 2.5));
    if (day.rhr - day.rhrBaseline >= thr) {
      out.push({ kind: "alert", icon: "💓", title: "靜息心率偏高",
        text: `今天 ${day.rhr.toFixed(0)} bpm，比你的基準高 ${(day.rhr - day.rhrBaseline).toFixed(0)} bpm。可能是睡眠不足、生病前兆或前一天飲酒/劇烈運動，留意身體訊號。` });
    }
  }
  if (Number.isFinite(day.sleep.score)) {
    const h = day.sleep.hours;
    const good = day.sleep.score >= 75;
    out.push({ kind: good ? "good" : "watch", icon: "🌙", title: `昨晚睡了 ${h.toFixed(1)} 小時，睡眠分數 ${day.sleep.score.toFixed(0)}`,
      text: good ? "睡得不錯，今天適合安排有挑戰的事。" :
        h < settings.sleepGoalHours ? `距離 ${settings.sleepGoalHours} 小時目標還差 ${(settings.sleepGoalHours - h).toFixed(1)} 小時，今晚試著提早就寢。` :
        "睡眠時數夠但品質一般，留意睡前咖啡因與螢幕。" });
  } else if (day.hasIntraday || Number.isFinite(day.rhr)) {
    out.push({ kind: "info", icon: "🌙", title: "沒有昨晚的睡眠紀錄", text: "戴著 Apple Watch 睡覺並開啟睡眠追蹤，才能計算睡眠分數與 Body Battery 充電。" });
  }
  if (Number.isFinite(day.stress) && day.stress >= 70) {
    out.push({ kind: "alert", icon: "🧘", title: "今天壓力偏高", text: "HRV 低於平常、心率偏高。安排 3 分鐘呼吸練習，或把高強度訓練移到明天。", action: "breathe" });
  } else if (Number.isFinite(day.recovery) && day.recovery >= 75) {
    out.push({ kind: "good", icon: "⚡", title: "恢復狀態良好", text: "身體準備好了，今天可以挑戰高強度訓練或重要任務。" });
  }
  if (day.battery && day.battery.now <= 25) {
    out.push({ kind: "watch", icon: "🔋", title: "Body Battery 偏低", text: `目前約 ${day.battery.now}%。減少刺激、早點休息，讓今晚好好充電。` });
  }
  if (isLatest && Number.isFinite(day.activity.steps) && day.activity.steps < settings.stepsGoal) {
    const gap = settings.stepsGoal - day.activity.steps;
    out.push({ kind: "info", icon: "🚶", title: `距離步數目標還差 ${Math.round(gap).toLocaleString()} 步`,
      text: gap < 2500 ? "出門走 20 分鐘就能達標。" : "今天活動量偏低，找機會多走動一下。" });
  } else if (Number.isFinite(day.activity.steps) && day.activity.steps >= settings.stepsGoal) {
    out.push({ kind: "good", icon: "🎯", title: "步數目標達成", text: `${Math.round(day.activity.steps).toLocaleString()} 步，做得好！` });
  }
  if (day.hrvStatus && day.hrvStatus.trend === "down" && prevDay && prevDay.hrvStatus && prevDay.hrvStatus.trend === "down") {
    out.push({ kind: "watch", icon: "📉", title: "HRV 連續多日低於基準", text: "近一週 HRV 持續低於你的正常區間，身體可能在累積疲勞，安排一天完全休息。" });
  }
  return out;
}

// ---- period aggregation (daily / weekly / monthly trends) -------------------

function isoWeekKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

export function aggregatePeriod(days, getter, period = "day") {
  if (period === "day") return days.map((d) => ({ key: d.date, label: d.date.slice(5), value: getter(d), n: 1 }));
  const groups = new Map();
  for (const d of days) {
    const key = period === "week" ? isoWeekKey(d.date) : d.date.slice(0, 7);
    const v = getter(d);
    let g = groups.get(key);
    if (!g) { g = { key, sum: 0, n: 0 }; groups.set(key, g); }
    if (Number.isFinite(v)) { g.sum += v; g.n++; }
  }
  return [...groups.values()].map((g) => ({
    key: g.key, label: period === "week" ? `${g.key.slice(5)} 週` : g.key, value: g.n ? g.sum / g.n : NaN, n: g.n,
  }));
}

export function meanOf(days, getter) { return mean(days.map(getter)); }

// Share of days in each stress level over a slice of days.
export function stressDistribution(days) {
  const counts = { relaxed: 0, balanced: 0, tense: 0, high: 0 };
  let n = 0;
  for (const d of days) {
    if (!Number.isFinite(d.stress)) continue;
    counts[d.stressLevel.key]++; n++;
  }
  return { counts, n };
}

export { clamp, mean, hhmmToOffset };
