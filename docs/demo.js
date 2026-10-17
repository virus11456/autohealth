// Synthetic Apple Health dataset so the app can be explored without an export.
// Produces the same shape as parser.js's parseExport(): quantities, sleep,
// workouts — including intraday heart-rate samples so the real-time stress
// timeline and Body Battery have something to chew on.

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateDemo({ days = 120, seed = 7, endDate = new Date() } = {}) {
  const rand = mulberry32(seed);
  const gauss = (sd = 1) => {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
  };
  const q = { steps: [], active_energy: [], distance: [], flights: [], hr: [], resting_hr: [], hrv: [], spo2: [], respiratory: [], vo2max: [] };
  const sleep = [];
  const workouts = [];

  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  const start = new Date(end); start.setDate(start.getDate() - days + 1);
  const push = (key, value, t, unitSec = 60) => q[key].push({ start: t, end: new Date(t.getTime() + unitSec * 1000), value, source: "Demo Watch" });

  for (let d = 0; d < days; d++) {
    const day = new Date(start); day.setDate(start.getDate() + d);
    const weekday = day.getDay();
    const weekend = weekday === 0 || weekday === 6;
    const weekly = Math.sin((2 * Math.PI * d) / 7);
    const stressWave = 0.5 + 0.5 * Math.sin((2 * Math.PI * d) / 23); // slow life-stress cycle
    const stressful = (!weekend && rand() < 0.25 + 0.3 * stressWave);

    // sleep ending this morning
    let sleepHours = 7.3 + 0.5 * weekly - (stressful ? 1.1 : 0) + gauss(0.45);
    if (d === days - 25) sleepHours = 3.9; // a terrible night
    sleepHours = Math.max(3.5, Math.min(9.5, sleepHours));
    const bedtimeMin = 23 * 60 + 15 + (weekend ? 45 : 0) + gauss(28);
    const bedStart = new Date(day); bedStart.setDate(day.getDate() - 1); bedStart.setHours(0, 0, 0, 0);
    bedStart.setMinutes(bedtimeMin);
    const inBedMin = sleepHours * 60 / (0.86 + 0.06 * rand());
    const sleepEnd = new Date(bedStart.getTime() + inBedMin * 60000);
    sleep.push({ start: bedStart, end: sleepEnd, stage: "InBed", source: "Demo iPhone" });
    // stage segments alternating
    let cursor = new Date(bedStart.getTime() + 12 * 60000);
    const totalAsleep = sleepHours * 60;
    const deepTarget = totalAsleep * (0.14 + 0.06 * rand());
    const remTarget = totalAsleep * (0.19 + 0.06 * rand());
    let deepLeft = deepTarget, remLeft = remTarget, coreLeft = totalAsleep - deepTarget - remTarget;
    let cycle = 0;
    while (deepLeft + remLeft + coreLeft > 1 && cursor < sleepEnd) {
      const order = cycle < 2 ? ["AsleepCore", "AsleepDeep", "AsleepCore", "AsleepREM"] : ["AsleepCore", "AsleepREM", "AsleepCore", "AsleepDeep"];
      for (const st of order) {
        let mins;
        if (st === "AsleepDeep") { mins = Math.min(deepLeft, 15 + 20 * rand()); deepLeft -= mins; }
        else if (st === "AsleepREM") { mins = Math.min(remLeft, 12 + 25 * rand()); remLeft -= mins; }
        else { mins = Math.min(coreLeft, 25 + 30 * rand()); coreLeft -= mins; }
        if (mins <= 0.5) continue;
        const segEnd = new Date(cursor.getTime() + mins * 60000);
        sleep.push({ start: cursor, end: segEnd, stage: st, source: "Demo Watch" });
        cursor = segEnd;
        if (rand() < 0.18) { // brief awakening
          const aw = new Date(cursor.getTime() + (2 + 6 * rand()) * 60000);
          sleep.push({ start: cursor, end: aw, stage: "Awake", source: "Demo Watch" });
          cursor = aw;
        }
      }
      cycle++;
      if (cycle > 12) break;
    }

    // physiology for the day
    const baseRhr = 58 + 4 * (d / days);
    const rhr = baseRhr - 1.6 * (sleepHours - 7.2) + (stressful ? 3.5 : 0) + gauss(1.4) + (d === days - 25 ? 7 : 0);
    const hrv = Math.max(12, 52 + 4.5 * (sleepHours - 7.2) - (stressful ? 10 : 0) - 6 * (d / days) + gauss(5) - (d === days - 25 ? 15 : 0));
    const noon = new Date(day); noon.setHours(8, 30, 0, 0);
    push("resting_hr", +rhr.toFixed(0), noon);
    push("respiratory", +(14.2 + gauss(0.9)).toFixed(1), noon);
    if (d % 9 === 0) push("vo2max", +(41 + gauss(0.8) + 1.5 * (d / days)).toFixed(1), noon);

    // HRV samples: a few overnight + occasional daytime (Apple Watch style)
    for (const h of [1.5, 3.5, 5.5]) {
      const t = new Date(bedStart.getTime() + h * 3600e3);
      if (t < sleepEnd) push("hrv", +(hrv + gauss(6)).toFixed(1), t);
    }
    if (rand() < 0.6) { const t = new Date(day); t.setHours(13 + Math.floor(rand() * 7), Math.floor(rand() * 60)); push("hrv", +(hrv - 8 + gauss(7)).toFixed(1), t); }

    // SpO2 overnight
    for (const h of [1, 3, 5]) {
      const t = new Date(bedStart.getTime() + h * 3600e3);
      if (t < sleepEnd) push("spo2", +Math.min(100, 96.8 + gauss(0.7) - (d === days - 25 ? 1.5 : 0)).toFixed(1), t);
    }

    // workout
    let workout = null;
    if ((!weekend && (weekday === 2 || weekday === 4) && rand() < 0.85) || (weekend && rand() < 0.5)) {
      const ws = new Date(day); ws.setHours(weekend ? 9 : 18, 30 + Math.floor(rand() * 20), 0, 0);
      const dur = 30 + Math.floor(rand() * 35);
      workout = { start: ws, end: new Date(ws.getTime() + dur * 60000), durationMin: dur,
        type: rand() < 0.6 ? "Running" : (rand() < 0.5 ? "Cycling" : "FunctionalStrengthTraining"),
        energy: Math.round(dur * (7 + 3 * rand())), source: "Demo Watch" };
      workouts.push(workout);
    }

    // intraday heart rate every 10 minutes + steps hourly
    let steps = 0, energy = 0;
    for (let h = 0; h < 24; h++) {
      const hourStart = new Date(day); hourStart.setHours(h, 0, 0, 0);
      const asleep = hourStart >= bedStart && hourStart < sleepEnd;
      const inWorkout = workout && hourStart.getTime() + 1800e3 >= workout.start && hourStart.getTime() + 1800e3 <= workout.end;
      let hourSteps = 0;
      for (let m = 0; m < 60; m += 10) {
        const t = new Date(hourStart.getTime() + m * 60000);
        if (t > end.getTime() + 86400e3) break;
        let hrv;
        if (t >= bedStart && t < sleepEnd) hrv = rhr - 6 + gauss(2.5);
        else if (workout && t >= workout.start && t <= workout.end) hrv = 135 + 25 * rand() + gauss(6);
        else {
          const hour = h + m / 60;
          const dayCurve = 10 + 10 * Math.sin(((hour - 8) / 14) * Math.PI);
          const meeting = (!weekend && ((hour >= 10 && hour < 12) || (hour >= 14 && hour < 17))) ? 6 : 0;
          hrv = rhr + dayCurve + meeting + (stressful ? 9 : 0) + gauss(5);
        }
        push("hr", +hrv.toFixed(0), t, 10);
      }
      if (!asleep) {
        const active = h >= 7 && h <= 22;
        hourSteps = active ? Math.max(0, 300 + 500 * rand() + (h === 8 || h === 18 ? 900 : 0) + (weekend && h >= 10 && h <= 16 ? 700 : 0)) : 0;
        if (inWorkout) hourSteps += workout.type === "Running" ? 4500 : 300;
        if (stressful && !weekend) hourSteps *= 0.75;
        hourSteps = Math.round(hourSteps);
        steps += hourSteps;
        const e = hourSteps * 0.045 + (inWorkout ? (workout.energy || 300) : 0);
        energy += e;
        if (hourSteps > 0) {
          push("steps", hourSteps, hourStart, 3600);
          push("active_energy", +e.toFixed(1), hourStart, 3600);
          push("distance", +(hourSteps * 0.00074).toFixed(3), hourStart, 3600);
        }
      }
    }
    push("flights", Math.max(0, Math.round(7 + gauss(4))), noon);
  }

  for (const k of Object.keys(q)) {
    if (!q[k].length) delete q[k];
    else q[k].sort((a, b) => a.start - b.start);
  }
  sleep.sort((a, b) => a.start - b.start);
  return { quantities: q, sleep, workouts };
}
