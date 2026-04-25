import { parseExport, METRIC_BY_KEY } from "./parser.js";
import { buildDailyFrame, columnValues, rollingMean } from "./aggregator.js";
import {
  spearman, correlationMatrix, laggedCorrelations, detectAnomalies,
  generateInsights, analyzableColumns, labelOf, METRIC_LABELS,
  DRIVERS_DEFAULT, RESPONSES_DEFAULT,
} from "./analyzer.js";

const state = {
  parsed: null,
  frame: null,
  filtered: null,
  window: 7,
  sigma: 2.0,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------- file handling ------------------------------------------

function setupDropzone() {
  const dz = $("#dropzone");
  const input = $("#fileInput");
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); dz.classList.remove("drag");
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });
  input.addEventListener("change", (e) => {
    if (e.target.files.length) loadFile(e.target.files[0]);
  });
}

async function loadFile(file) {
  const progressEl = $("#progress > div");
  const textEl = $("#progressText");
  $("#progressWrap").style.display = "block";
  textEl.textContent = "讀取中…";
  try {
    const parsed = await parseExport(file, ({ phase, message, progress }) => {
      textEl.textContent = message;
      if (progress != null) progressEl.style.width = `${Math.min(100, progress * 100)}%`;
    });
    state.parsed = parsed;
    state.frame = buildDailyFrame(parsed);
    if (!state.frame.rows.length) {
      textEl.textContent = "解析完成，但沒有可分析的資料。";
      return;
    }
    progressEl.style.width = "100%";
    textEl.textContent = `完成：${state.frame.rows.length} 天，${state.frame.columns.length} 個指標`;
    initDashboard();
  } catch (err) {
    console.error(err);
    textEl.textContent = `失敗：${err.message}`;
  }
}

// ---------------- dashboard ----------------------------------------------

function initDashboard() {
  $("#dashboard").style.display = "block";
  $("#uploadCard").style.display = "none";

  // date range defaults: last 180 days
  const allDates = state.frame.rows.map((r) => r.date);
  const min = allDates[0], max = allDates[allDates.length - 1];
  const startDefault = (() => {
    const d = new Date(max);
    d.setDate(d.getDate() - 180);
    const candidate = d.toISOString().slice(0, 10);
    return candidate < min ? min : candidate;
  })();

  const startEl = $("#dateStart");
  const endEl = $("#dateEnd");
  startEl.min = endEl.min = min;
  startEl.max = endEl.max = max;
  startEl.value = startDefault;
  endEl.value = max;

  const winEl = $("#window");
  const sigEl = $("#sigma");
  winEl.value = state.window;
  sigEl.value = state.sigma;

  for (const el of [startEl, endEl, winEl, sigEl]) {
    el.addEventListener("change", () => {
      state.window = Math.max(2, Math.min(60, parseInt(winEl.value) || 7));
      state.sigma = Math.max(1, Math.min(5, parseFloat(sigEl.value) || 2));
      applyFilter();
      renderAll();
    });
  }

  applyFilter();
  setupTabs();
  setupTrendPicker();
  setupLagPicker();
  renderAll();
}

function applyFilter() {
  const start = $("#dateStart").value;
  const end = $("#dateEnd").value;
  const rows = state.frame.rows.filter((r) => r.date >= start && r.date <= end);
  const cols = state.frame.columns;
  state.filtered = { rows, columns: cols, dates: rows.map((r) => r.date) };
}

function setupTabs() {
  $$(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.remove("active"));
      $$(".tab-content").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("#" + t.dataset.tab).classList.add("active");
      // re-render plotly charts on tab switch (they need to be visible to size)
      renderAll();
    });
  });
}

function renderAll() {
  if (!state.filtered) return;
  renderKPIs();
  renderInsights();
  renderTrendChart();
  renderHeatmap();
  renderLagTable();
  renderAnomalies();
  renderDailyTable();
}

// ---------------- KPI strip ----------------------------------------------

function tail(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }
function meanFinite(arr) {
  let s = 0, n = 0;
  for (const v of arr) if (Number.isFinite(v)) { n++; s += v; }
  return n ? s / n : NaN;
}

function kpi(label, col, fmt, suffix = "") {
  const vals = columnValues(state.filtered, col);
  const recent = meanFinite(tail(vals, 7));
  const prior = meanFinite(tail(vals, 28).slice(0, 21));
  const div = document.createElement("div");
  div.className = "kpi";
  div.innerHTML = `<div class="label">${label}</div>
    <div class="value">${Number.isFinite(recent) ? fmt(recent) + suffix : "—"}</div>
    <div class="delta muted">${Number.isFinite(recent) && Number.isFinite(prior)
      ? `${recent - prior >= 0 ? "+" : ""}${(recent - prior).toFixed(2)} vs 21 天前`
      : "&nbsp;"}</div>`;
  return div;
}

function renderKPIs() {
  const wrap = $("#kpis");
  wrap.innerHTML = "";
  const items = [
    ["睡眠時數",  "sleep_hours",   (v) => v.toFixed(1), " h"],
    ["靜息心率",  "resting_hr",    (v) => v.toFixed(0), " bpm"],
    ["HRV",       "hrv",           (v) => v.toFixed(0), " ms"],
    ["血氧 (日均)", "spo2",        (v) => v.toFixed(1), " %"],
    ["步數",      "steps",         (v) => v.toFixed(0), ""],
    ["活動消耗",  "active_energy", (v) => v.toFixed(0), " kcal"],
  ];
  for (const [lbl, col, fmt, suffix] of items) {
    if (!state.filtered.columns.includes(col)) {
      const div = document.createElement("div");
      div.className = "kpi";
      div.innerHTML = `<div class="label">${lbl}</div><div class="value">—</div>`;
      wrap.appendChild(div);
    } else {
      wrap.appendChild(kpi(lbl, col, fmt, suffix));
    }
  }
}

// ---------------- insights -----------------------------------------------

function renderInsights() {
  const wrap = $("#insightsList");
  wrap.innerHTML = "";
  const insights = generateInsights(state.filtered);
  if (!insights.length) {
    wrap.innerHTML = `<div class="empty-state">資料不足以產生洞察（建議至少 4 週紀錄）。</div>`;
    return;
  }
  for (const ins of insights) {
    const div = document.createElement("div");
    div.className = `insight ${ins.severity}`;
    div.innerHTML = `<div class="title"></div><div class="detail"></div>`;
    div.querySelector(".title").textContent = ins.title;
    div.querySelector(".detail").textContent = ins.detail;
    wrap.appendChild(div);
  }
}

// ---------------- trend chart --------------------------------------------

function setupTrendPicker() {
  const picker = $("#trendPicker");
  picker.innerHTML = "";
  const cols = analyzableColumns(state.frame, 3);
  const defaults = ["sleep_hours", "resting_hr", "hrv", "spo2", "steps"]
    .filter((c) => cols.includes(c)).slice(0, 3);
  for (const col of cols) {
    const id = `pk-${col}`;
    const wrap = document.createElement("label");
    wrap.htmlFor = id;
    wrap.innerHTML = `<input type="checkbox" id="${id}" value="${col}"
      ${defaults.includes(col) ? "checked" : ""}> ${labelOf(col)}`;
    wrap.querySelector("input").addEventListener("change", renderTrendChart);
    picker.appendChild(wrap);
  }
}

function renderTrendChart() {
  if (!state.filtered) return;
  const chosen = $$("#trendPicker input:checked").map((i) => i.value);
  const div = $("#chart");
  if (!chosen.length) {
    Plotly.purge(div);
    div.innerHTML = `<div class="empty-state">請至少選一個指標。</div>`;
    return;
  }
  div.innerHTML = "";
  const x = state.filtered.rows.map((r) => r.date);
  const traces = [];
  const colors = ["#4f8cff", "#34c38f", "#f0a020", "#ef4444", "#a78bfa", "#22d3ee", "#f472b6"];
  chosen.forEach((col, i) => {
    const raw = columnValues(state.filtered, col);
    const smoothed = rollingMean(raw, state.window);
    const c = colors[i % colors.length];
    traces.push({
      x, y: raw, name: `${labelOf(col)} (原始)`,
      mode: "markers", marker: { size: 4, opacity: 0.35, color: c },
      legendgroup: col, showlegend: false,
    });
    traces.push({
      x, y: smoothed, name: `${labelOf(col)} (${state.window} 天均)`,
      mode: "lines", line: { width: 2.5, color: c }, legendgroup: col,
    });
  });
  Plotly.newPlot(div, traces, {
    margin: { l: 50, r: 20, t: 20, b: 40 },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#e6e9ef", family: "inherit" },
    xaxis: { gridcolor: "#2a3140" },
    yaxis: { gridcolor: "#2a3140" },
    legend: { orientation: "h", y: -0.2 },
    hovermode: "x unified",
    height: 460,
  }, { displaylogo: false, responsive: true });
}

// ---------------- correlation heatmap ------------------------------------

function renderHeatmap() {
  if (!state.filtered) return;
  const div = $("#heatmap");
  const cols = analyzableColumns(state.filtered, 14);
  if (cols.length < 2) {
    div.innerHTML = `<div class="empty-state">樣本不足以計算相關矩陣。</div>`;
    Plotly.purge(div);
    return;
  }
  div.innerHTML = "";
  const { matrix } = correlationMatrix(state.filtered, cols);
  const labels = cols.map(labelOf);
  const text = matrix.map((row) => row.map((v) => Number.isFinite(v) ? v.toFixed(2) : ""));
  Plotly.newPlot(div, [{
    type: "heatmap", z: matrix, x: labels, y: labels,
    text, texttemplate: "%{text}", textfont: { size: 11, color: "#e6e9ef" },
    zmin: -1, zmax: 1,
    colorscale: [
      [0, "#ef4444"], [0.25, "#f59e0b"], [0.5, "#1c2230"],
      [0.75, "#60a5fa"], [1, "#1d4ed8"],
    ],
    hovertemplate: "%{x} ↔ %{y}<br>r = %{z:.2f}<extra></extra>",
  }], {
    margin: { l: 130, r: 40, t: 20, b: 130 },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#e6e9ef", family: "inherit" },
    xaxis: { tickangle: -40 },
    height: 600,
  }, { displaylogo: false, responsive: true });
}

// ---------------- lagged correlation -------------------------------------

function setupLagPicker() {
  const cols = analyzableColumns(state.frame, 14);
  const driversBox = $("#driversPicker");
  const responsesBox = $("#responsesPicker");
  driversBox.innerHTML = "";
  responsesBox.innerHTML = "";
  for (const col of cols) {
    const dId = `dr-${col}`, rId = `rs-${col}`;
    const dDef = DRIVERS_DEFAULT.includes(col);
    const rDef = RESPONSES_DEFAULT.includes(col);
    const dl = document.createElement("label");
    dl.innerHTML = `<input type="checkbox" id="${dId}" value="${col}" ${dDef ? "checked" : ""}> ${labelOf(col)}`;
    const rl = document.createElement("label");
    rl.innerHTML = `<input type="checkbox" id="${rId}" value="${col}" ${rDef ? "checked" : ""}> ${labelOf(col)}`;
    driversBox.appendChild(dl); responsesBox.appendChild(rl);
    dl.querySelector("input").addEventListener("change", renderLagTable);
    rl.querySelector("input").addEventListener("change", renderLagTable);
  }
  $("#lagFrom").addEventListener("change", renderLagTable);
  $("#lagTo").addEventListener("change", renderLagTable);
}

function renderLagTable() {
  if (!state.filtered) return;
  const drivers = $$("#driversPicker input:checked").map((i) => i.value);
  const responses = $$("#responsesPicker input:checked").map((i) => i.value);
  const lagFrom = parseInt($("#lagFrom").value) || -1;
  const lagTo = parseInt($("#lagTo").value) || 2;
  const lags = [];
  for (let l = Math.min(lagFrom, lagTo); l <= Math.max(lagFrom, lagTo); l++) lags.push(l);

  const tbody = $("#lagTable tbody");
  tbody.innerHTML = "";
  if (!drivers.length || !responses.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">請至少選一個驅動因子與一個反應因子。</td></tr>`;
    return;
  }
  const rows = laggedCorrelations(state.filtered, drivers, responses, lags);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">沒有足夠樣本。</td></tr>`;
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    const rColor = row.r >= 0 ? "var(--good)" : "var(--bad)";
    tr.innerHTML = `
      <td>${labelOf(row.driver)}</td>
      <td>${labelOf(row.response)}</td>
      <td class="num">${row.lag}</td>
      <td class="num" style="color:${rColor}">${row.r >= 0 ? "+" : ""}${row.r.toFixed(2)}</td>
      <td class="num">${row.p.toFixed(3)}</td>
      <td class="num">${row.n}</td>`;
    tbody.appendChild(tr);
  }
}

// ---------------- anomalies ----------------------------------------------

function renderAnomalies() {
  if (!state.filtered) return;
  const tbody = $("#anomTable tbody");
  tbody.innerHTML = "";
  const rows = detectAnomalies(state.filtered, state.sigma);
  $("#anomTitle").textContent = `異常天（≥ ${state.sigma.toFixed(1)}σ vs 前 28 天）`;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">近期沒有顯著異常。</td></tr>`;
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    const zColor = Math.abs(row.z) >= 3 ? "var(--bad)" :
                   Math.abs(row.z) >= 2 ? "var(--warn)" : "var(--muted)";
    tr.innerHTML = `
      <td>${row.date}</td>
      <td>${labelOf(row.metric)}</td>
      <td class="num">${row.value.toFixed(2)}</td>
      <td class="num">${row.baseline_mean.toFixed(2)}</td>
      <td class="num" style="color:${zColor}">${row.z >= 0 ? "+" : ""}${row.z.toFixed(2)}</td>`;
    tbody.appendChild(tr);
  }
}

// ---------------- daily table --------------------------------------------

function renderDailyTable() {
  if (!state.filtered) return;
  const cols = state.filtered.columns;
  const head = $("#dailyTable thead");
  const body = $("#dailyTable tbody");
  head.innerHTML = "<tr><th>日期</th>" + cols.map((c) => `<th class="num">${labelOf(c)}</th>`).join("") + "</tr>";
  body.innerHTML = "";

  // limit to last 90 days for performance; full data is in CSV download
  const display = state.filtered.rows.slice(-90);
  for (const row of display) {
    const tds = cols.map((c) => {
      const v = row[c];
      return `<td class="num">${Number.isFinite(v) ? v.toFixed(2) : ""}</td>`;
    });
    body.innerHTML += `<tr><td>${row.date}</td>${tds.join("")}</tr>`;
  }
  $("#dailyHint").textContent = display.length < state.filtered.rows.length
    ? `顯示最近 ${display.length} 天（共 ${state.filtered.rows.length} 天，下載 CSV 取得完整資料）`
    : `共 ${display.length} 天`;

  $("#downloadCsv").onclick = downloadCsv;
}

function downloadCsv() {
  const cols = state.filtered.columns;
  const header = ["date", ...cols].join(",");
  const lines = state.filtered.rows.map((r) => {
    const vals = [r.date, ...cols.map((c) => Number.isFinite(r[c]) ? r[c] : "")];
    return vals.join(",");
  });
  const csv = "﻿" + [header, ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "autohealth_daily.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------- boot ----------------------------------------------------

setupDropzone();
