import { parseExport } from "./parser.js";
import { buildDailyFrame } from "./aggregator.js";
import { computeReadiness, computeEnvStress } from "./analyzer.js";
import {
  getSettings, setSettings, clearSettings, isConfigured,
  testConnection, callMinimax, callMinimaxChat,
  buildCompactSummaryPrompt, buildDeepAnalysisPrompt, buildChatSystem,
} from "./ai.js";
import {
  renderTask1, renderTask2, renderTask3, renderTask4,
  renderTask5, renderTask6, renderTask7,
} from "./tasks.js";

const state = {
  parsed: null,
  frame: null,        // full parsed frame (date-unfiltered)
  filtered: null,     // current date-filtered frame (used by tasks 2-7)
  activeTab: "tab-task2",
  // chat state
  aiMessages: [],     // [{role: 'user'|'assistant', content: '...'}]
  aiChatBusy: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Crude iOS detection — covers iPad on iPadOS 13+ which fakes Macintosh UA.
function isIOS() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+: identifies as Mac with touch support
  return navigator.maxTouchPoints > 1 && /Macintosh/.test(ua);
}

// Show pre-upload warnings: a permanent iOS-memory advisory on iPhone/iPad,
// plus a one-shot "looks like the last attempt got killed mid-parse" message
// when sessionStorage shows a parse started but never finished.
function setupUploadWarnings() {
  if (isIOS()) {
    const w = $("#iosWarn");
    if (w) w.style.display = "block";
  }
  // sessionStorage is cleared on tab close but persists across tab reloads
  // — exactly the signal we need to detect "the OS killed this tab during
  // upload and reloaded it from scratch".
  try {
    if (sessionStorage.getItem("autohealth.parseInProgress") === "1") {
      const w = $("#reloadWarn");
      if (w) w.style.display = "block";
      sessionStorage.removeItem("autohealth.parseInProgress");
    }
  } catch {}
}

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

  // Demo data button — fetch the bundled synthetic export.xml so the user
  // can preview the dashboard without uploading anything. Sets a session
  // flag that we use to render a "this is fake data" banner.
  const demoBtn = $("#loadDemo");
  if (demoBtn) {
    demoBtn.addEventListener("click", async () => {
      const textEl = $("#progressText");
      $("#progressWrap").style.display = "block";
      textEl.textContent = "載入示範資料中…";
      try {
        const resp = await fetch("./demo.xml");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const file = new File([blob], "demo.xml", { type: "application/xml" });
        state.isDemo = true;
        await loadFile(file);
      } catch (e) {
        textEl.textContent = `載入示範失敗：${e.message}`;
      }
    });
  }

  // Exit demo: just hard-reload back to upload screen.
  const exitBtn = $("#exitDemo");
  if (exitBtn) {
    exitBtn.addEventListener("click", () => location.reload());
  }
}

async function loadFile(file) {
  const wrap = $("#progressWrap");
  const bar = $("#progress");
  const fill = $("#progress > div");
  const textEl = $("#progressText");
  const pctEl = $("#progressPercent");
  wrap.style.display = "block";
  bar.classList.add("indeterminate");
  fill.style.width = "0%";
  pctEl.textContent = "";
  const sizeMb = (file.size / 1024 / 1024).toFixed(file.size < 10 * 1024 * 1024 ? 2 : 1);
  textEl.textContent = `📦 開始讀取 ${file.name}（${sizeMb} MB）…`;

  try { sessionStorage.setItem("autohealth.parseInProgress", "1"); } catch {}
  if (isIOS() && file.size > 100 * 1024 * 1024) {
    textEl.textContent = `📦 讀取 ${sizeMb} MB 中… iPhone 記憶體緊，可能會失敗，建議改用桌機。`;
  }
  try {
    const parsed = await parseExport(file, ({ message, progress }) => {
      textEl.textContent = message;
      if (progress != null) {
        bar.classList.remove("indeterminate");
        const pct = Math.min(100, progress * 100);
        fill.style.width = `${pct}%`;
        pctEl.textContent = `${pct.toFixed(0)}%`;
      } else {
        bar.classList.add("indeterminate");
        pctEl.textContent = "";
      }
    });
    // Parse succeeded — clear the mid-parse marker so reload-detection
    // doesn't show a false alarm next page load.
    try { sessionStorage.removeItem("autohealth.parseInProgress"); } catch {}
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
    bar.classList.remove("indeterminate");
    fill.style.width = "100%";
    pctEl.textContent = "100%";
    textEl.textContent = `完成：${state.frame.rows.length} 天，${state.frame.columns.length} 個指標`;
    initDashboard();
  } catch (err) {
    console.error(err);
    // Caught error means we made it back here — not an OS kill. Clear marker.
    try { sessionStorage.removeItem("autohealth.parseInProgress"); } catch {}
    textEl.textContent = `失敗：${err.message}`;
  }
}

// ---------------- dashboard ----------------------------------------------

function initDashboard() {
  $("#dashboard").style.display = "block";
  // Hide the entire landing page (hero + upload + task preview + privacy)
  // not just the upload card — once data is loaded the explanatory content
  // is no longer needed.
  const landing = $("#landingPage");
  if (landing) landing.style.display = "none";
  else $("#uploadCard").style.display = "none";  // legacy fallback
  // Show demo banner if we loaded the bundled sample
  const demoBanner = $("#demoBanner");
  if (demoBanner && state.isDemo) demoBanner.style.display = "flex";

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
      // Manual date changes clear the preset highlight
      $$(".preset-btn").forEach((b) => b.classList.remove("active"));
      applyFilter();
      renderActiveTab();
    });
  }

  // Quick-select preset buttons
  $$(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.preset;
      const maxStr = state.frame.rows[state.frame.rows.length - 1].date;
      const minStr = state.frame.rows[0].date;
      const maxD = new Date(maxStr + "T00:00:00");
      let target;
      if (preset === "1m")      { target = new Date(maxD); target.setMonth(maxD.getMonth() - 1); }
      else if (preset === "3m") { target = new Date(maxD); target.setMonth(maxD.getMonth() - 3); }
      else if (preset === "1y") { target = new Date(maxD); target.setFullYear(maxD.getFullYear() - 1); }
      else                      { target = new Date(minStr + "T00:00:00"); }
      const startStr = target.toISOString().slice(0, 10);
      $("#dateStart").value = startStr < minStr ? minStr : startStr;
      $("#dateEnd").value = maxStr;
      $$(".preset-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      applyFilter();
      renderActiveTab();
    });
  });

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
  renderVitalsBar();
}

// User profile (age / sex) — used to pick age-stratified reference ranges
// for HRV and VO2 Max. Only persists to localStorage.
const PROFILE_KEY = "autohealth.profile.v1";
function getProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}"); }
  catch { return {}; }
}
function setProfile(p) {
  const clean = {};
  if (Number.isFinite(+p.age) && p.age >= 10 && p.age <= 120) clean.age = +p.age;
  if (p.sex === "male" || p.sex === "female") clean.sex = p.sex;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(clean));
}

const VITALS_ITEMS = [
  { key: "hr",          label: "平均心率",     unit: "bpm",        digits: 0 },
  { key: "resting_hr",  label: "平均靜息心率", unit: "bpm",        digits: 0 },
  { key: "spo2",        label: "平均血氧",     unit: "%",          digits: 1 },
  { key: "hrv",         label: "平均 HRV",     unit: "ms",         digits: 0 },
  { key: "sleep_hours", label: "平均睡眠",     unit: "小時",       digits: 1 },
  { key: "vo2max",      label: "平均心適能",   unit: "ml/kg·min",  digits: 1 },
  { key: "respiratory", label: "平均呼吸",     unit: "次/分",      digits: 1 },
  { key: "daylight",    label: "平均日照",     unit: "分鐘",       digits: 0 },
];

// Reference ranges for the persistent vitals bar — generic adult population.
// `normal` = healthy range, `safe` = anything outside is medically concerning.
// `note` is the source of truth caveat shown in the range text.
const VITAL_REFERENCES = {
  hr: {
    normal: [65, 95], safe: [55, 110],
    explain: {
      low:  "可能是運動員體質；如有頭暈 / 疲倦要就醫",
      high: "壓力大 / 缺水 / 咖啡因過多 / 發炎前期；長期 > 100 建議檢查",
    },
  },
  resting_hr: {
    normal: [55, 80], safe: [45, 100],
    explain: {
      low:  "心肺體能很好（運動員常見）；< 45 + 頭暈要就醫",
      high: "睡眠不足 / 壓力 / 過度訓練 / 早期感染；持續 > 80 要注意",
    },
  },
  spo2: {
    normal: [95, 100], safe: [92, 100],
    explain: {
      low:  "持續 < 95 要注意，< 92 應就醫；常見原因：肺功能、睡眠呼吸中止",
      high: "—",
    },
  },
  hrv: {
    // SDNN ms by age tier — generic adult, sex-agnostic.
    // Source: HRV declines steadily with age; ranges from various reviews.
    byAge: [
      { upTo: 30,       normal: [50, 100], safe: [25, 150] },
      { upTo: 40,       normal: [40, 90],  safe: [22, 130] },
      { upTo: 50,       normal: [35, 75],  safe: [20, 110] },
      { upTo: 60,       normal: [30, 65],  safe: [18, 100] },
      { upTo: 70,       normal: [25, 55],  safe: [15, 90]  },
      { upTo: Infinity, normal: [20, 45],  safe: [12, 80]  },
    ],
    fallback: { normal: [25, 80], safe: [15, 150] },
    explain: {
      low:  "自律神經緊繃，常見於壓力 / 過勞 / 老化 / 睡眠不足",
      high: "恢復力很好（少見偏高，通常是好事）",
    },
    note: "HRV 個別差異大，跟自己過去比 > 跟標準比",
  },
  sleep_hours: {
    normal: [7, 9], safe: [5.5, 10],
    explain: {
      low:  "長期 < 6 小時 → 心血管 / 認知 / 免疫力都會受影響",
      high: "持續 > 9 小時還累 = 可能潛在疾病；偶爾補眠沒關係",
    },
  },
  vo2max: {
    // Generic age-tier ranges. Sex-stratified via bySexAge below.
    byAge: [
      { upTo: 30,       normal: [38, 55], safe: [25, 70] },
      { upTo: 40,       normal: [34, 50], safe: [22, 65] },
      { upTo: 50,       normal: [31, 46], safe: [20, 60] },
      { upTo: 60,       normal: [28, 42], safe: [18, 55] },
      { upTo: 70,       normal: [25, 38], safe: [16, 50] },
      { upTo: Infinity, normal: [22, 34], safe: [14, 45] },
    ],
    bySexAge: {
      male: [
        { upTo: 30,       normal: [42, 60], safe: [28, 75] },
        { upTo: 40,       normal: [38, 54], safe: [25, 68] },
        { upTo: 50,       normal: [34, 48], safe: [22, 62] },
        { upTo: 60,       normal: [30, 44], safe: [20, 56] },
        { upTo: 70,       normal: [27, 39], safe: [17, 50] },
        { upTo: Infinity, normal: [24, 35], safe: [15, 45] },
      ],
      female: [
        { upTo: 30,       normal: [35, 50], safe: [22, 65] },
        { upTo: 40,       normal: [31, 46], safe: [20, 58] },
        { upTo: 50,       normal: [28, 42], safe: [18, 52] },
        { upTo: 60,       normal: [25, 38], safe: [16, 48] },
        { upTo: 70,       normal: [22, 34], safe: [14, 42] },
        { upTo: Infinity, normal: [20, 30], safe: [12, 38] },
      ],
    },
    fallback: { normal: [28, 55], safe: [18, 70] },
    explain: {
      low:  "心肺體能偏低，規律有氧運動可改善（每週 150 分鐘中強度）",
      high: "心肺體能很好",
    },
    note: "VO2 Max 隨年齡每 10 年自然下降約 10%",
  },
  respiratory: {
    normal: [12, 20], safe: [10, 24],
    explain: {
      low:  "持續 < 12 可能是心肺 / 神經系統問題",
      high: "可能是發燒 / 發炎 / 焦慮 / 心肺問題；持續 > 20 建議就醫",
    },
  },
  daylight: {
    normal: [30, 120], safe: [10, 360],
    explain: {
      low:  "日照不足 → 維生素 D 不足、晝夜節律失調、白天精神差",
      high: "曬太多注意防曬與曬傷風險",
    },
  },
};

// Pick the right range tier given user's profile. Returns the resolved
// {normal, safe, source} where source is "age" / "sex+age" / "generic".
function resolveRanges(ref, profile) {
  if (!ref) return null;
  if (ref.bySexAge && profile?.sex && Number.isFinite(profile?.age)) {
    const list = ref.bySexAge[profile.sex];
    if (list) {
      const tier = list.find((t) => profile.age <= t.upTo);
      if (tier) return { normal: tier.normal, safe: tier.safe, source: "sex+age" };
    }
  }
  if (ref.byAge && Number.isFinite(profile?.age)) {
    const tier = ref.byAge.find((t) => profile.age <= t.upTo);
    if (tier) return { normal: tier.normal, safe: tier.safe, source: "age" };
  }
  if (ref.fallback) return { ...ref.fallback, source: "generic" };
  if (ref.normal && ref.safe) return { normal: ref.normal, safe: ref.safe, source: "generic" };
  return null;
}

function vitalStatus(value, range) {
  if (!Number.isFinite(value) || !range) return { cls: "empty", text: "—", direction: null };
  if (value < range.safe[0])   return { cls: "alert", text: "⚠ 太低", direction: "low" };
  if (value > range.safe[1])   return { cls: "alert", text: "⚠ 太高", direction: "high" };
  if (value < range.normal[0]) return { cls: "low",   text: "↓ 偏低", direction: "low" };
  if (value > range.normal[1]) return { cls: "low",   text: "↑ 偏高", direction: "high" };
  return { cls: "good", text: "✓ 正常", direction: null };
}

function renderVitalsBar() {
  const grid = $("#vitalsGrid");
  const periodEl = $("#vitalsPeriod");
  if (!grid || !state.filtered) return;

  const profile = getProfile();
  const rows = state.filtered.rows;
  if (periodEl) {
    const profileTag = Number.isFinite(profile.age)
      ? `　·　年齡 ${profile.age}${profile.sex === "male" ? " · 男" : profile.sex === "female" ? " · 女" : ""} 標準`
      : "";
    periodEl.textContent = rows.length
      ? `${rows[0].date} → ${rows[rows.length - 1].date}　·　${rows.length} 天${profileTag}`
      : "區間無資料";
  }

  let html = "";
  for (const it of VITALS_ITEMS) {
    let sum = 0, n = 0;
    for (const r of rows) {
      const v = r[it.key];
      if (Number.isFinite(v)) { sum += v; n++; }
    }
    const avg = n > 0 ? sum / n : NaN;
    const isEmpty = !Number.isFinite(avg);
    const display = isEmpty ? "—" : avg.toFixed(it.digits);
    const ref = VITAL_REFERENCES[it.key];
    const range = resolveRanges(ref, profile);
    const status = vitalStatus(avg, range);
    const refRange = range
      ? `${range.source === "sex+age" ? `${profile.age}歲${profile.sex === "male" ? "男" : "女"}` :
          range.source === "age"     ? `${profile.age}歲` :
                                       "一般成人"} ${range.normal[0]}–${range.normal[1]} ${it.unit}`
      : "";
    const hint = (ref && status.direction) ? ref.explain[status.direction] : "";
    const note = ref?.note;

    html += `
      <div class="vital-tile vital-${status.cls}${isEmpty ? " empty" : ""}" data-key="${it.key}">
        <div class="vital-header">
          <span class="vital-label">${it.label}</span>
          <span class="vital-status">${status.text}</span>
        </div>
        <div class="vital-value">${display}${isEmpty ? "" : `<span class="vital-unit">${it.unit}</span>`}</div>
        ${refRange ? `<div class="vital-ref muted">${refRange}</div>` : ""}
        ${hint ? `<div class="vital-hint">${hint}</div>` : ""}
        ${note && !isEmpty ? `<div class="vital-note muted">ℹ ${note}</div>` : ""}
      </div>`;
  }
  grid.innerHTML = html;
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
    const p = getProfile();
    $("#cfgAge").value = Number.isFinite(p.age) ? p.age : "";
    $("#cfgSex").value = p.sex || "";
    $("#cfgTestResult").classList.remove("show", "ok", "fail");
    // Render data health inline if data has been loaded
    const dh = $("#dataHealthInline");
    if (dh) {
      if (state.frame && state.frame.rows.length) {
        renderTask1(state.frame, dh);
      } else {
        dh.innerHTML = '<p class="muted">尚未上傳資料。先關閉設定 → 上傳 export.zip → 再打開這裡看健檢結果。</p>';
      }
    }
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
    setProfile({
      age: $("#cfgAge").value,
      sex: $("#cfgSex").value,
    });
    close();
    refreshAiStatus();
    renderVitalsBar();    // pick up new age-stratified ranges immediately
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

// ---------------- Chat (Task: chatbot over the analysed data) ------------

function appendChatMessage(role, content, opts = {}) {
  const wrap = $("#aiChatMessages");
  const div = document.createElement("div");
  div.className = `ai-chat-msg ${role}` + (opts.cls ? " " + opts.cls : "");
  if (opts.escape || role === "user") {
    div.textContent = content;
  } else {
    div.innerHTML = renderMarkdown(content);
  }
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

async function sendChatMessage(rawText) {
  if (state.aiChatBusy) return;
  const input = $("#aiChatInput");
  const userMsg = (rawText ?? input.value).trim();
  if (!userMsg) return;
  if (!isConfigured()) {
    appendChatMessage("assistant", "⚠ 還沒設定 token，請點右上角 ⚙ 貼上你的 MiniMax token。", { escape: true, cls: "error" });
    return;
  }
  if (!state.frame) {
    appendChatMessage("assistant", "⚠ 還沒上傳資料，先回首頁上傳 export.zip 再來聊。", { escape: true, cls: "error" });
    return;
  }
  input.value = "";
  appendChatMessage("user", userMsg);
  state.aiMessages.push({ role: "user", content: userMsg });

  const thinking = appendChatMessage("assistant", "思考中…", { escape: true, cls: "thinking" });
  state.aiChatBusy = true;
  $("#aiChatSend").disabled = true;
  try {
    const messages = [
      { role: "system", content: buildChatSystem(state.frame) },
      ...state.aiMessages,
    ];
    const { content } = await callMinimaxChat(messages, { maxTokens: 1200 });
    thinking.remove();
    appendChatMessage("assistant", content);
    state.aiMessages.push({ role: "assistant", content });
    // Trim history if it gets too long (keep last 16 turns)
    if (state.aiMessages.length > 20) state.aiMessages = state.aiMessages.slice(-16);
  } catch (e) {
    thinking.remove();
    appendChatMessage("assistant", `❌ 出錯：${e.message}`, { escape: true, cls: "error" });
  } finally {
    state.aiChatBusy = false;
    $("#aiChatSend").disabled = false;
  }
}

function clearChat() {
  if (state.aiMessages.length && !confirm("確定清空目前對話？")) return;
  state.aiMessages = [];
  $("#aiChatMessages").innerHTML = "";
}

function setupAiTab() {
  refreshAiStatus();
  $("#aiSummaryBtn").addEventListener("click", () => runAi("compact"));
  $("#aiDeepBtn").addEventListener("click", () => runAi("deep"));
  $("#aiPreviewBtn").addEventListener("click", previewPrompt);
  $("#aiClearChat").addEventListener("click", clearChat);

  // Chat handlers
  $("#aiChatSend").addEventListener("click", () => sendChatMessage());
  $("#aiChatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  $$("#aiChatSuggestions .suggestion").forEach((btn) => {
    btn.addEventListener("click", () => sendChatMessage(btn.textContent));
  });
}

// ---------------- boot ----------------------------------------------------

setupDropzone();
setupSettingsModal();
setupUploadWarnings();
