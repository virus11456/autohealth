// Node-based smoke test of the JS pipeline against sample_data/export.xml.
// Mirrors scripts/smoke_test.py so we can verify Python and JS implementations
// produce comparable results.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Blob } from "node:buffer";
import { ReadableStream, TextDecoderStream } from "node:stream/web";

// JSDOM-like global polyfills for the parser. The browser version uses
// File / file.stream(); in node we wrap the Buffer in a Blob-like object.
globalThis.JSZip = undefined; // not needed for plain XML
globalThis.ReadableStream = ReadableStream;
globalThis.TextDecoderStream = TextDecoderStream;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const xmlPath = resolve(root, "sample_data/export.xml");

const buf = readFileSync(xmlPath);
const file = new Blob([buf], { type: "application/xml" });
// `parseExport` calls file.slice(...).arrayBuffer() and file.stream(); Blob has both.

const { parseExport } = await import(resolve(root, "docs/parser.js"));
const { buildDailyFrame, columnValues } = await import(resolve(root, "docs/aggregator.js"));
const {
  spearman, correlationMatrix, laggedCorrelations, detectAnomalies,
  generateInsights, analyzableColumns,
} = await import(resolve(root, "docs/analyzer.js"));

const t0 = Date.now();
const parsed = await parseExport(file);
const t1 = Date.now();

console.log(`parsed in ${t1 - t0} ms`);
console.log(`record count: ${parsed.recordCount}`);
console.log(`days with data: ${parsed.dailyAggs.size}`);
console.log("per-metric record counts:");
const perMetric = {};
for (const dayMap of parsed.dailyAggs.values()) {
  for (const [mKey, acc] of dayMap) {
    perMetric[mKey] = (perMetric[mKey] || 0) + acc.count;
  }
}
for (const [k, n] of Object.entries(perMetric).sort()) {
  console.log(`  ${k.padEnd(20)} ${n}`);
}
console.log(`  sleep                ${parsed.sleep.length}`);
console.log(`  spo2Raw              ${parsed.spo2Raw.length}`);

const frame = buildDailyFrame(parsed);
console.log(`\ndaily frame: ${frame.rows.length} days x ${frame.columns.length} cols`);
console.log("columns:", frame.columns.join(", "));

if (!frame.columns.includes("sleep_hours")) throw new Error("missing sleep_hours");
if (!frame.columns.includes("resting_hr")) throw new Error("missing resting_hr");

// Spearman: sleep_hours vs resting_hr should be negative (matches Python)
const sh = columnValues(frame, "sleep_hours");
const rhr = columnValues(frame, "resting_hr");
const corr = spearman(sh, rhr);
console.log(`\nspearman sleep_hours <-> resting_hr: r=${corr.r.toFixed(3)} p=${corr.p.toExponential(2)} n=${corr.n}`);
if (corr.r > -0.3) throw new Error(`expected negative correlation, got ${corr.r}`);

const cols = analyzableColumns(frame);
const cm = correlationMatrix(frame, cols);
console.log(`correlation matrix: ${cm.cols.length}x${cm.cols.length}`);

const lc = laggedCorrelations(frame,
  ["sleep_hours", "steps"],
  ["resting_hr", "hrv"],
  [0, 1, 2]);
console.log(`\ntop 3 lagged correlations:`);
for (const row of lc.slice(0, 3)) {
  console.log(`  ${row.driver} -> ${row.response} lag=${row.lag} r=${row.r.toFixed(2)} n=${row.n}`);
}

const anom = detectAnomalies(frame, 2.0);
console.log(`\nanomalies: ${anom.length}`);
for (const a of anom.slice(0, 5)) {
  console.log(`  ${a.date} ${a.metric.padEnd(14)} value=${a.value.toFixed(2)} z=${a.z.toFixed(2)}`);
}

const insights = generateInsights(frame);
console.log(`\ninsights: ${insights.length}`);
for (const ins of insights.slice(0, 6)) {
  console.log(`  [${ins.severity}] ${ins.title}`);
  console.log(`        ${ins.detail}`);
}

console.log("\nOK");
