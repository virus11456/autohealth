// Habit tracking (healthy-habit builder) and the guided breathing exercise.
// Habits are stored locally; "auto" habits are completed from health data.

import { lsGet, lsSet } from "./store.js";

const KEY = "autohealth.habits.v1";

export const DEFAULT_HABITS = [
  { id: "breathe",  name: "正念呼吸 3 分鐘",   icon: "🧘", auto: "breathe" },
  { id: "steps",    name: "達成步數目標",       icon: "🚶", auto: "steps" },
  { id: "sleep",    name: "睡滿目標時數",       icon: "🌙", auto: "sleep" },
  { id: "bedtime",  name: "準時就寢",           icon: "🛏️", auto: "bedtime" },
  { id: "workout",  name: "運動 20 分鐘以上",   icon: "🏃", auto: "workout" },
  { id: "water",    name: "喝水 2000ml",        icon: "💧" },
  { id: "noscreen", name: "睡前一小時不看螢幕", icon: "📵" },
];

export function loadHabits() {
  const saved = lsGet(KEY, null);
  if (saved && Array.isArray(saved.habits)) return saved;
  const init = { habits: DEFAULT_HABITS.map((h) => ({ ...h })), log: {}, breathingSessions: [] };
  lsSet(KEY, init);
  return init;
}

export function saveHabits(state) { lsSet(KEY, state); }

export function toggleHabit(state, habitId, date) {
  const day = (state.log[date] ||= {});
  day[habitId] = !day[habitId];
  saveHabits(state);
  return day[habitId];
}

export function addHabit(state, name, icon = "✅") {
  const id = "h_" + Math.random().toString(36).slice(2, 8);
  state.habits.push({ id, name, icon });
  saveHabits(state);
  return id;
}

export function removeHabit(state, habitId) {
  state.habits = state.habits.filter((h) => h.id !== habitId);
  for (const d of Object.values(state.log)) delete d[habitId];
  saveHabits(state);
}

// Auto-complete habits from the scored day + settings. Only fills in `true`
// (never un-checks something the user ticked manually).
export function autoCompleteFromData(state, scored, settings, hhmmToOffset) {
  let changed = false;
  for (const day of scored.days) {
    const log = (state.log[day.date] ||= {});
    for (const h of state.habits) {
      if (!h.auto || log[h.id]) continue;
      let done = false;
      if (h.auto === "steps") done = Number.isFinite(day.activity.steps) && day.activity.steps >= settings.stepsGoal;
      else if (h.auto === "sleep") done = Number.isFinite(day.sleep.hours) && day.sleep.hours >= settings.sleepGoalHours;
      else if (h.auto === "bedtime") done = Number.isFinite(day.sleep.bedtime) && day.sleep.bedtime <= hhmmToOffset(settings.bedtimeGoal) + 15;
      else if (h.auto === "workout") done = day.activity.workouts.some((w) => w.durationMin >= 20);
      else if (h.auto === "breathe") done = state.breathingSessions.some((s) => s.date === day.date && s.seconds >= 150);
      if (done) { log[h.id] = true; changed = true; }
    }
  }
  if (changed) saveHabits(state);
  return changed;
}

export function streak(state, habitId, uptoDate) {
  // consecutive days ending at uptoDate (inclusive) with the habit done
  let n = 0;
  const d = new Date(uptoDate + "T00:00:00");
  for (let i = 0; i < 365; i++) {
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (state.log[k] && state.log[k][habitId]) n++;
    else if (i > 0) break; // today may still be pending
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function completionRate(state, habitId, dates) {
  let done = 0;
  for (const k of dates) if (state.log[k] && state.log[k][habitId]) done++;
  return dates.length ? done / dates.length : 0;
}

export function logBreathing(state, date, seconds, pattern) {
  state.breathingSessions.push({ date, seconds, pattern, at: Date.now() });
  saveHabits(state);
}

// ---- breathing patterns -----------------------------------------------------

export const BREATH_PATTERNS = {
  box:   { name: "箱式呼吸", phases: [["吸氣", 4], ["屏息", 4], ["吐氣", 4], ["屏息", 4]], desc: "4-4-4-4，穩定注意力" },
  relax: { name: "4-7-8 放鬆", phases: [["吸氣", 4], ["屏息", 7], ["吐氣", 8]], desc: "延長吐氣，啟動副交感神經" },
  coherent: { name: "共振呼吸", phases: [["吸氣", 5.5], ["吐氣", 5.5]], desc: "約每分鐘 5.5 次，提升 HRV 的經典節奏" },
};

/**
 * Runs a breathing session. onTick({phase, phaseSeconds, phaseTotal, remaining, scale})
 * Returns a controller { stop() }.
 */
export function runBreathing(patternKey, totalSeconds, onTick, onDone) {
  const pattern = BREATH_PATTERNS[patternKey] || BREATH_PATTERNS.box;
  const startAt = performance.now();
  let raf = 0, stopped = false;
  const cycle = pattern.phases.reduce((s, p) => s + p[1], 0);
  const frame = (now) => {
    if (stopped) return;
    const elapsed = (now - startAt) / 1000;
    const remaining = Math.max(0, totalSeconds - elapsed);
    const t = elapsed % cycle;
    let acc = 0, phase = pattern.phases[0], phaseT = t;
    for (const p of pattern.phases) { if (t < acc + p[1]) { phase = p; phaseT = t - acc; break; } acc += p[1]; }
    const prog = phaseT / phase[1];
    let scale;
    if (phase[0] === "吸氣") scale = 0.55 + 0.45 * prog;
    else if (phase[0] === "吐氣") scale = 1 - 0.45 * prog;
    else scale = pattern.phases.indexOf(phase) % 2 === 1 && pattern.phases[(pattern.phases.indexOf(phase) + 1) % pattern.phases.length][0] === "吐氣" ? 1 : 0.55;
    onTick({ phase: phase[0], phaseSeconds: Math.ceil(phase[1] - phaseT), phaseTotal: phase[1], remaining, scale, elapsed });
    if (remaining <= 0) { stopped = true; onDone(totalSeconds); return; }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return { stop() { stopped = true; cancelAnimationFrame(raf); return Math.round((performance.now() - startAt) / 1000); } };
}
