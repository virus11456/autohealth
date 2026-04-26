// Comprehensive QA: render every task with various edge cases.
import { readFileSync } from "node:fs";
import { Blob } from "node:buffer";
import { ReadableStream, TextDecoderStream } from "node:stream/web";
globalThis.ReadableStream = ReadableStream;
globalThis.TextDecoderStream = TextDecoderStream;

// Stub Plotly + document so renderTaskN doesn't throw on chart calls
const plotlyCalls = [];
globalThis.Plotly = {
  newPlot: (div, traces, layout, config) => {
    plotlyCalls.push({ div: typeof div === "string" ? div : "(elem)", nTraces: traces?.length, layout, config });
  },
};
globalThis.document = {
  getElementById: (id) => ({ id, _is_stub: true }),
};
globalThis.confirm = () => true;
globalThis.alert = () => {};

const { parseExport } = await import("../docs/parser.js");
const { buildDailyFrame } = await import("../docs/aggregator.js");
const { computeReadiness, computeEnvStress } = await import("../docs/analyzer.js");
const tasks = await import("../docs/tasks.js");

const buf = readFileSync("/home/user/autohealth/sample_data/export.xml");
const f = new Blob([buf], { type: "application/xml" });
const parsed = await parseExport(f);
const frame = buildDailyFrame(parsed);
const r = computeReadiness(frame), e = computeEnvStress(frame);
for (let i = 0; i < frame.rows.length; i++) {
  frame.rows[i].readiness = r[i];
  frame.rows[i].env_stress = e[i];
}
frame.columns.push("readiness", "env_stress");

const failures = [];
function check(label, fn) {
  try {
    const result = fn();
    return { label, ok: true, result };
  } catch (e) {
    failures.push({ label, error: e.message + "\n" + e.stack });
    return { label, ok: false, error: e.message };
  }
}

const stubContainer = () => {
  let html = "";
  return {
    set innerHTML(v) { html = v; },
    get innerHTML() { return html; },
  };
};

// Test 1: render every task on full sample
const renderers = [
  ["task1", tasks.renderTask1, frame],
  ["task2", tasks.renderTask2, frame],
  ["task3", tasks.renderTask3, frame],
  ["task4", tasks.renderTask4, frame],
  ["task5", tasks.renderTask5, frame],
  ["task6", tasks.renderTask6, frame],
  ["task7", tasks.renderTask7, frame],
];

console.log("=== Test 1: render all 7 tasks on full sample ===");
for (const [name, fn, fr] of renderers) {
  const c = stubContainer();
  const r = check(`${name} full sample`, () => { fn(fr, c); return c.innerHTML.length; });
  console.log(`  ${name}: ${r.ok ? `✓ ${r.result} chars` : `✗ ${r.error}`}`);
}

// Test 2: empty frame (no rows)
console.log("\n=== Test 2: empty frame ===");
const emptyFrame = { rows: [], columns: frame.columns, dates: [] };
for (const [name, fn] of renderers) {
  const c = stubContainer();
  const r = check(`${name} empty`, () => { fn(emptyFrame, c); return c.innerHTML.includes("尚未載入") || c.innerHTML.includes("資料量太少") || c.innerHTML.includes("empty-state"); });
  console.log(`  ${name}: ${r.ok ? (r.result ? "✓ shows empty state" : "✗ rendered but no empty state msg") : `✗ ${r.error}`}`);
}

// Test 3: short frame (5 days only — too short for most tasks)
console.log("\n=== Test 3: short frame (5 days) ===");
const shortFrame = { rows: frame.rows.slice(0, 5), columns: frame.columns, dates: frame.dates.slice(0, 5) };
for (const [name, fn] of renderers) {
  const c = stubContainer();
  const r = check(`${name} short`, () => { fn(shortFrame, c); return c.innerHTML.length > 0; });
  console.log(`  ${name}: ${r.ok ? "✓ rendered (short)" : `✗ ${r.error}`}`);
}

// Test 4: frame missing key columns (e.g. no walking_hr → Task 2 should warn)
console.log("\n=== Test 4: frame missing walking_hr ===");
const noWalkingFrame = {
  rows: frame.rows.map(r => { const cp = {...r}; delete cp.walking_hr; return cp; }),
  columns: frame.columns.filter(c => c !== "walking_hr"),
  dates: frame.dates,
};
for (const [name, fn] of renderers) {
  const c = stubContainer();
  const r = check(`${name} no walking_hr`, () => { fn(noWalkingFrame, c); return c.innerHTML.length > 0; });
  console.log(`  ${name}: ${r.ok ? "✓ rendered" : `✗ ${r.error}`}`);
}

// Test 5: frame with all NaN values for some metrics
console.log("\n=== Test 5: frame with all-NaN HRV ===");
const noHrvFrame = {
  rows: frame.rows.map(r => ({ ...r, hrv: NaN, hrv_baseline30: NaN, hrv_zscore30: NaN })),
  columns: frame.columns,
  dates: frame.dates,
};
for (const [name, fn] of renderers) {
  const c = stubContainer();
  const r = check(`${name} no HRV`, () => { fn(noHrvFrame, c); return c.innerHTML; });
  if (r.ok) {
    const hasWarn = r.result.includes("缺少") || r.result.includes("資料量") || r.result.includes("資料不足") || r.result.includes("status-empty");
    console.log(`  ${name}: ${hasWarn ? "✓ handled gracefully" : "△ rendered without warning"}`);
  } else {
    console.log(`  ${name}: ✗ ${r.error}`);
  }
}

// Test 6: validate generated HTML structure (all rendered HTML for tasks should have expected anchors)
console.log("\n=== Test 6: structural checks on full-sample renders ===");
const structuralChecks = {
  task1: ["coverage", "task-callout", "task-table"],
  task2: ["metric-card", "metric-grid", "task-table", "metric-status"],
  task3: ["metric-card", "task-table"],
  task4: ["metric-card", "metric-grid", "task-table"],
  task5: ["metric-card", "task-table"],
  task6: ["readiness-hero", "readiness-value", "task-table"],
  task7: ["metric-card", "task-table"],
};
for (const [name, fn, fr] of renderers) {
  const c = stubContainer();
  fn(fr, c);
  const checks = structuralChecks[name] || [];
  const missing = checks.filter(s => !c.innerHTML.includes(s));
  console.log(`  ${name}: ${missing.length === 0 ? `✓ all ${checks.length} anchors present` : `✗ missing: ${missing.join(", ")}`}`);
}

// Test 7: detect "undefined" / "NaN" / "null" leaking into rendered HTML
console.log("\n=== Test 7: leak detection ===");
const leakPatterns = [
  ["raw 'undefined' in HTML", />undefined</],
  ["raw 'NaN' in HTML",       />NaN</],
  ["raw 'null' in HTML",      />null</],
  ["literal '[object Object]'", /\[object Object\]/],
];
for (const [name, fn, fr] of renderers) {
  const c = stubContainer();
  fn(fr, c);
  for (const [label, re] of leakPatterns) {
    if (re.test(c.innerHTML)) {
      console.log(`  ${name}: ✗ ${label}`);
      // show context
      const m = c.innerHTML.match(new RegExp(`.{0,40}${re.source}.{0,40}`));
      if (m) console.log(`    context: ${m[0].replace(/\n/g, " ")}`);
    }
  }
}

// Test 8: Plotly call inspection — every chart div in HTML should get plotted
console.log("\n=== Test 8: Plotly chart wiring ===");
plotlyCalls.length = 0;
for (const [name, fn, fr] of renderers) {
  const c = stubContainer();
  plotlyCalls.length = 0;
  fn(fr, c);
  // find every div with class metric-chart or task-chart that has an id
  const chartDivs = [...c.innerHTML.matchAll(/id="(t\d-[\w-]+)"\s+class="(?:metric-chart|task-chart)"/g)].map(m => m[1]);
  console.log(`  ${name}: ${chartDivs.length} chart divs declared, ${plotlyCalls.length} Plotly.newPlot() calls`);
  // For Plotly.newPlot called with stubbed div from getElementById(id), id is in our mapped object
  // The mismatch can hint at unwired charts
}

console.log("\n=== Failures ===");
if (failures.length === 0) console.log("none ✓");
else for (const f of failures) console.log(f.label + ": " + f.error);
