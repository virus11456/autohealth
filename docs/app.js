import { parseExport, METRIC_BY_KEY } from "./parser.js";
import { buildDailyFrame, columnValues, rollingMean } from "./aggregator.js";
import {
  spearman, correlationMatrix, laggedCorrelations, detectAnomalies,
  generateInsights, analyzableColumns, labelOf, METRIC_LABELS,
  DRIVERS_DEFAULT, RESPONSES_DEFAULT,
  computeReadiness, computeEnvStress,
} from "./analyzer.js";
import {
  getSettings, setSettings, clearSettings, isConfigured,
  testConnection, callMinimax,
  buildCompactSummaryPrompt, buildDeepAnalysisPrompt,
} from "./ai.js";

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
    // Phase 3 composite scores — injected as columns so they flow through KPI
    // strip, trend chart, daily table, and CSV download for free.
    const readiness = computeReadiness(state.frame);
    const envStress = computeEnvStress(state.frame);
    for (let i = 0; i < state.frame.rows.length; i++) {
      state.frame.rows[i].readiness = readiness[i];
      state.frame.rows[i].env_stress = envStress[i];
    }
    state.frame.columns.push("readiness", "env_stress");
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
  setupAiTab();
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
  renderScoreBanner();
  renderKPIs();
  renderInsights();
  renderTrendChart();
  renderHeatmap();
  renderLagTable();
  renderAnomalies();
  renderDailyTable();
}

// ---------------- Phase 3 score banner -----------------------------------

function scoreBand(score, inverse = false) {
  // For env_stress (inverse=true): high score = bad, so flip the band.
  if (!Number.isFinite(score)) return { cls: "empty", label: "—" };
  const v = inverse ? 100 - score : score;
  if (v >= 70) return { cls: "good",  label: "良好" };
  if (v >= 50) return { cls: "fair",  label: "尚可" };
  if (v >= 30) return { cls: "low",   label: "偏低" };
  return         { cls: "alert", label: "警戒" };
}

function latestFinite(col) {
  const vals = columnValues(state.filtered, col);
  for (let i = vals.length - 1; i >= 0; i--) if (Number.isFinite(vals[i])) return vals[i];
  return NaN;
}

function renderScoreBanner() {
  const wrap = $("#scoreBanner");
  wrap.innerHTML = "";
  const items = [
    {
      key: "readiness", label: "🌿 恢復分數",
      hint: "HRV ↑ + 靜息心率 ↓ + 睡眠分數 + 呼吸頻率穩定的綜合 0-100 分",
      inverse: false,
    },
    {
      key: "env_stress", label: "🌫 環境壓力",
      hint: "日照不足 + 血氧偏低 + 呼吸頻率偏高 + HRV 偏低（高 = 警訊）",
      inverse: true,
    },
  ];
  for (const it of items) {
    const v = latestFinite(it.key);
    const band = scoreBand(v, it.inverse);
    const card = document.createElement("div");
    card.className = `score-card ${band.cls}`;
    const valText = Number.isFinite(v) ? `${v.toFixed(0)}` : "—";
    card.innerHTML = `
      <div class="label">${it.label}</div>
      <div class="value">${valText}<span class="scale"> / 100 · ${band.label}</span></div>
      <div class="hint">${it.hint}</div>`;
    wrap.appendChild(card);
  }
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
    ["睡眠分數",  "sleep_score",   (v) => v.toFixed(0), " /100"],
    ["靜息心率",  "resting_hr",    (v) => v.toFixed(0), " bpm"],
    ["HRV",       "hrv",           (v) => v.toFixed(0), " ms"],
    ["血氧 (日均)", "spo2",        (v) => v.toFixed(1), " %"],
    ["步數",      "steps",         (v) => v.toFixed(0), ""],
    ["日照",      "daylight",      (v) => v.toFixed(0), " 分"],
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
  const defaults = ["readiness", "hrv", "resting_hr", "sleep_score"]
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

function isDerivedCol(c) {
  return c.endsWith("_baseline30") || c.endsWith("_zscore30");
}

function renderDailyTable() {
  if (!state.filtered) return;
  const cols = state.filtered.columns.filter((c) => !isDerivedCol(c));
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
  // CSV includes the rolling-baseline / z-score columns so users have the full
  // Phase 3 inputs available offline.
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

// ---------------- AI tab + settings modal --------------------------------

function setupSettingsModal() {
  const modal = $("#settingsModal");
  const open = () => {
    const s = getSettings();
    $("#cfgToken").value = s.token;
    $("#cfgBaseUrl").value = s.baseUrl;
    $("#cfgModel").value = s.model;
    $("#cfgGroupId").value = s.groupId;
    $("#cfgTestResult").classList.remove("show", "ok", "fail");
    modal.style.display = "flex";
  };
  const close = () => { modal.style.display = "none"; };

  $("#openSettings").addEventListener("click", open);
  $("#closeSettings").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  $("#cfgSave").addEventListener("click", () => {
    setSettings({
      token: $("#cfgToken").value,
      baseUrl: $("#cfgBaseUrl").value,
      model: $("#cfgModel").value,
      groupId: $("#cfgGroupId").value,
    });
    close();
    refreshAiStatus();
  });

  $("#cfgClear").addEventListener("click", () => {
    if (!confirm("確定清除 token？localStorage 會被刪掉。")) return;
    clearSettings();
    $("#cfgToken").value = "";
    $("#cfgGroupId").value = "";
    refreshAiStatus();
  });

  $("#cfgTest").addEventListener("click", async () => {
    // Test using the values currently in the form, not the saved ones
    const live = {
      token: $("#cfgToken").value.trim(),
      baseUrl: $("#cfgBaseUrl").value.trim() || "https://api.minimaxi.com/v1",
      model: $("#cfgModel").value.trim() || "MiniMax-M2.7",
      groupId: $("#cfgGroupId").value.trim(),
    };
    const result = $("#cfgTestResult");
    result.classList.remove("ok", "fail");
    result.classList.add("show");
    result.textContent = "測試中…";
    try {
      const r = await testConnection(live);
      result.textContent = r.message;
      result.classList.add(r.ok ? "ok" : "fail");
    } catch (e) {
      result.textContent = `❌ 例外：${e.message}`;
      result.classList.add("fail");
    }
  });
}

function refreshAiStatus() {
  const el = $("#aiStatus");
  if (!el) return;
  if (!isConfigured()) {
    el.className = "ai-status warn";
    el.innerHTML = "尚未設定 MiniMax token。點右上角 ⚙ 貼上 token + endpoint 後再回來。";
    return;
  }
  const s = getSettings();
  el.className = "ai-status";
  el.innerHTML = `已設定：<code>${s.model}</code> @ <code>${s.baseUrl}</code>${s.groupId ? ` · GroupId: <code>${s.groupId}</code>` : ""}`;
}

// Tiny markdown → HTML. Handles headings (#/##/###), bold, italic, inline code,
// fenced code blocks, unordered lists, blockquote, paragraphs. Enough for what
// the LLM produces in our prompts; if more is needed we can swap in marked.js.
function renderMarkdown(md) {
  // 1. extract fenced code blocks first so we don't munge their contents
  const codeBlocks = [];
  md = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return ` CODE${codeBlocks.length - 1} `;
  });
  // 2. escape inline HTML in the rest
  md = escapeHtml(md);
  // 3. headings
  md = md.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  md = md.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  md = md.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  // 4. blockquote
  md = md.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  // 5. inline emphasis & code (after escape so &lt; is safe)
  md = md.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  md = md.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  md = md.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // 6. unordered list — collect consecutive `- ` lines
  md = md.replace(/(?:^- .+(?:\n|$))+/gm, (m) => {
    const items = m.trim().split("\n").map(l => `<li>${l.replace(/^- /, "")}</li>`).join("");
    return `<ul>${items}</ul>`;
  });
  // 7. paragraphs — wrap blank-line-separated runs of text that aren't already block elements
  md = md.split(/\n{2,}/).map(block => {
    if (/^\s*<(h\d|ul|ol|pre|blockquote)/.test(block)) return block;
    if (/^\s* CODE\d+ \s*$/.test(block)) return block;
    if (!block.trim()) return "";
    return `<p>${block.replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
  // 8. restore code blocks
  md = md.replace(/ CODE(\d+) /g, (_, i) => codeBlocks[Number(i)]);
  return md;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function setAiOutput(html) {
  const el = $("#aiOutput");
  el.innerHTML = html;
}

function setAiBusy(msg) {
  const status = $("#aiStatus");
  status.className = "ai-status busy";
  status.textContent = msg;
}

function setAiError(msg) {
  const status = $("#aiStatus");
  status.className = "ai-status error";
  status.textContent = msg;
}

async function runAi(mode) {
  if (!state.filtered) return;
  if (!isConfigured()) {
    setAiError("尚未設定 token，先點右上角 ⚙。");
    return;
  }
  const builder = mode === "deep" ? buildDeepAnalysisPrompt : buildCompactSummaryPrompt;
  const { system, user } = builder(state.filtered);
  const maxTokens = mode === "deep" ? 8000 : 1500;

  const t0 = Date.now();
  setAiBusy(mode === "deep" ? "深度分析中（5-30 秒）…" : "AI 摘要中…");
  setAiOutput("");
  try {
    const { content } = await callMinimax(system, user, { maxTokens });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    setAiOutput(
      renderMarkdown(content) +
      `<div class="ai-meta">${mode === "deep" ? "深度分析" : "輕量摘要"} · ${elapsed}s · ${content.length.toLocaleString()} 字</div>`
    );
    refreshAiStatus();
  } catch (e) {
    setAiError(`失敗：${e.message}`);
  }
}

function previewPrompt() {
  if (!state.filtered) return;
  const { system, user } = buildCompactSummaryPrompt(state.filtered);
  const html = `<h3>System</h3><pre><code>${escapeHtml(system)}</code></pre>` +
               `<h3>User</h3><pre><code>${escapeHtml(user)}</code></pre>` +
               `<div class="ai-meta">這是「輕量摘要」會送出的內容。深度分析的 prompt 會更大（含完整分析期間 CSV）。</div>`;
  setAiOutput(html);
}

function setupAiTab() {
  refreshAiStatus();
  $("#aiSummaryBtn").addEventListener("click", () => runAi("compact"));
  $("#aiDeepBtn").addEventListener("click", () => runAi("deep"));
  $("#aiPreviewBtn").addEventListener("click", previewPrompt);
}

// ---------------- boot ----------------------------------------------------

setupDropzone();
setupSettingsModal();
