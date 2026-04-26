import { parseExport } from "./parser.js";
import { buildDailyFrame } from "./aggregator.js";
import { computeReadiness, computeEnvStress } from "./analyzer.js";
import {
  getSettings, setSettings, clearSettings, isConfigured,
  testConnection, callMinimax,
  buildCompactSummaryPrompt, buildDeepAnalysisPrompt,
} from "./ai.js";
import {
  renderTask1, renderTask2, renderTask3, renderTask4,
  renderTask5, renderTask6, renderTask7,
} from "./tasks.js";

const state = {
  parsed: null,
  frame: null,        // full parsed frame (date-unfiltered)
  filtered: null,     // current date-filtered frame (used by tasks 2-7)
  activeTab: "tab-task1",
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
    const parsed = await parseExport(file, ({ message, progress }) => {
      textEl.textContent = message;
      if (progress != null) progressEl.style.width = `${Math.min(100, progress * 100)}%`;
    });
    state.parsed = parsed;
    state.frame = buildDailyFrame(parsed);
    if (!state.frame.rows.length) {
      textEl.textContent = "解析完成，但沒有可分析的資料。";
      return;
    }
    // Inject Phase 3 composite scores so any task that wants today's snapshot
    // can read state.frame.rows[i].readiness / .env_stress directly. Task 6
    // re-computes its own spec'd readiness; this is just a baseline.
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

  for (const el of [startEl, endEl]) {
    el.addEventListener("change", () => {
      applyFilter();
      renderActiveTab();
    });
  }

  // The window / sigma controls were used by the now-removed trend / anomaly
  // tabs. Hide them so the controls bar stays minimal — the 7 tasks each carry
  // their own implicit windows. Date range still matters.
  const winWrap = $("#window") && $("#window").closest("div");
  const sigWrap = $("#sigma") && $("#sigma").closest("div");
  if (winWrap) winWrap.style.display = "none";
  if (sigWrap) sigWrap.style.display = "none";

  applyFilter();
  setupTabs();
  setupAiTab();
  renderActiveTab();
}

function applyFilter() {
  const start = $("#dateStart").value;
  const end = $("#dateEnd").value;
  const rows = state.frame.rows.filter((r) => r.date >= start && r.date <= end);
  state.filtered = { rows, columns: state.frame.columns, dates: rows.map((r) => r.date) };
}

function setupTabs() {
  $$(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.remove("active"));
      $$(".tab-content").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const id = t.dataset.tab;
      $("#" + id).classList.add("active");
      state.activeTab = id;
      renderActiveTab();
    });
  });
}

// Task 1 reads the unfiltered frame (it's about identifying useful windows);
// tasks 2-7 read the date-filtered slice the user is currently inspecting.
function renderActiveTab() {
  if (!state.frame) return;
  const id = state.activeTab;
  const container = $("#" + id);
  if (!container) return;
  switch (id) {
    case "tab-task1": renderTask1(state.frame, container); break;
    case "tab-task2": renderTask2(state.filtered, container); break;
    case "tab-task3": renderTask3(state.filtered, container); break;
    case "tab-task4": renderTask4(state.filtered, container); break;
    case "tab-task5": renderTask5(state.filtered, container); break;
    case "tab-task6": renderTask6(state.filtered, container); break;
    case "tab-task7": renderTask7(state.filtered, container); break;
    case "tab-ai":    /* AI tab is set up once, no per-render work */ break;
  }
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

// Tiny markdown → HTML. Handles fenced code, headings, bold, italic, inline
// code, lists, blockquote, paragraphs — enough for what the LLM produces.
function renderMarkdown(md) {
  const codeBlocks = [];
  md = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return ` CODE${codeBlocks.length - 1} `;
  });
  md = escapeHtml(md);
  md = md.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  md = md.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  md = md.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  md = md.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  md = md.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  md = md.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  md = md.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  md = md.replace(/(?:^- .+(?:\n|$))+/gm, (m) => {
    const items = m.trim().split("\n").map(l => `<li>${l.replace(/^- /, "")}</li>`).join("");
    return `<ul>${items}</ul>`;
  });
  md = md.split(/\n{2,}/).map(block => {
    if (/^\s*<(h\d|ul|ol|pre|blockquote)/.test(block)) return block;
    if (/^\s* CODE\d+ \s*$/.test(block)) return block;
    if (!block.trim()) return "";
    return `<p>${block.replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
  md = md.replace(/ CODE(\d+) /g, (_, i) => codeBlocks[Number(i)]);
  return md;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function setAiOutput(html) { $("#aiOutput").innerHTML = html; }
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
      `<div class="ai-meta">${mode === "deep" ? "深度分析" : "輕量摘要"} · ${elapsed}s · ${content.length.toLocaleString()} 字</div>`,
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
