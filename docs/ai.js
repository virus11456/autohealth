// MiniMax AI integration: settings (localStorage), connection test, prompt
// builders, and the call client. Designed for Approach A — token never leaves
// the user's browser, dashboard fetches MiniMax directly. If MiniMax doesn't
// return CORS headers (likely on CN endpoint), testConnection surfaces that
// clearly with a fix suggestion.

const STORAGE_KEY = "autohealth.minimax.v1";

const DEFAULTS = {
  token: "",
  baseUrl: "https://api.minimaxi.com/v1",  // CN; international = api.minimax.io
  model: "MiniMax-M2.7",                    // alt: MiniMax-M2.7-highspeed
  groupId: "",                              // optional, CN platform may require
};

export function getSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setSettings(s) {
  // strip empty / undefined keys before persisting
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (s[k] != null && String(s[k]).length > 0) clean[k] = String(s[k]).trim();
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
}

export function clearSettings() {
  localStorage.removeItem(STORAGE_KEY);
}

export function isConfigured(s = getSettings()) {
  return Boolean(s.token);
}

function endpointUrl(s) {
  return s.baseUrl.replace(/\/+$/, "") + "/chat/completions";
}

function authHeaders(s) {
  const h = {
    "Authorization": `Bearer ${s.token}`,
    "Content-Type": "application/json",
  };
  if (s.groupId) h["GroupId"] = s.groupId;
  return h;
}

// Minimal POST that just verifies the round-trip works. Asks for 1 output
// token to keep cost ~zero. Distinguishes the common failure modes:
//   - CORS / network         (browser-direct blocked)
//   - 401 unauthorized       (bad token / missing GroupId)
//   - 404 not found          (wrong endpoint path)
//   - 200 OK                 (Approach A confirmed viable)
export async function testConnection(s = getSettings()) {
  if (!s.token) return { ok: false, message: "尚未填入 token" };
  const url = endpointUrl(s);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: authHeaders(s),
      body: JSON.stringify({
        model: s.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });
    const text = await resp.text().catch(() => "(無回應內容)");
    if (resp.ok) {
      return { ok: true, message: `✅ 連線成功 (HTTP ${resp.status})。瀏覽器可直接打 MiniMax，方案 A 可行。` };
    }
    if (resp.status === 401) {
      return {
        ok: false,
        message: `❌ HTTP 401 認證失敗\n\n可能原因：\n  • token 不對 / 已過期\n  • CN 版需要 GroupId 但沒填\n\nMiniMax 回應：\n${text.slice(0, 600)}`,
      };
    }
    if (resp.status === 404) {
      const altPath = url.replace("/chat/completions", "/text/chatcompletion_v2");
      return {
        ok: false,
        message: `❌ HTTP 404 endpoint 不存在\n\n試試把「Endpoint base URL」換成不含 \`/v1\`，或直接用 MiniMax 原生 schema 路徑：\n  ${altPath}\n\nMiniMax 回應：\n${text.slice(0, 600)}`,
      };
    }
    return { ok: false, message: `❌ HTTP ${resp.status}\n\n${text.slice(0, 600)}` };
  } catch (e) {
    return {
      ok: false,
      message: `❌ 網路 / CORS 錯誤：${e.message}\n\n如果 console 裡看到「Access-Control-Allow-Origin」字樣，代表 MiniMax 沒給瀏覽器跨域權限，方案 A（瀏覽器直連）走不通。解法：\n  • 自己部署一個 30 行的 Cloudflare Worker 當 CORS 代理（我可以提供範本），key 還是只在你瀏覽器端\n  • 或改用 Streamlit 版（伺服器端打 MiniMax，無 CORS 問題）`,
    };
  }
}

// Send a real completion. Throws on non-2xx.
export async function callMinimax(system, user, opts = {}) {
  const s = getSettings();
  if (!s.token) throw new Error("尚未填入 MiniMax token，請先到「設定」貼上");
  const url = endpointUrl(s);
  const body = {
    model: s.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: opts.maxTokens ?? 2000,
    temperature: opts.temperature ?? 0.3,
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: authHeaders(s),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "(無回應)");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 600)}`);
  }
  const data = await resp.json();
  // OpenAI-compatible response shape; MiniMax follows this on /chat/completions
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`回應格式異常：${JSON.stringify(data).slice(0, 600)}`);
  }
  return { content, raw: data };
}

// ============================================================
// Prompt builders
// ============================================================

const COMPACT_SYSTEM = `你是 Apple Health 數據分析師。我會提供使用者最近的每日寬表 (CSV)，
請輸出**繁體中文** markdown，包含三段：

## 狀態總結
2-3 句：最近一週身體狀態總體如何，跟前 3 週比有什麼明顯變化。

## 異常解讀
2-4 句：列出最值得注意的異常或趨勢轉折，並用白話說明可能的生理意義（例：HRV 下降 + 靜息心率上升通常代表累積疲勞）。

## 行動建議
2-3 條 bullet：基於以上，建議使用者今天 / 本週可以調整的具體事項。

務必：
- 用簡潔、數字導向的口吻（例：「HRV 比基線低 1.4σ」），避免醫療化或恐嚇式語言
- 樣本不足以下結論時明說「資料不足」
- 結尾固定加：「⚠ 此為數據觀察，不構成醫療診斷；持續異常請就醫。」`;

const DEEP_SYSTEM = `你是 Apple Health 跨維度分析師。我會提供使用者完整分析期間的每日寬表
（含 30 天 baseline + z-score 衍生欄位）。請依下面 7 個任務逐項輸出
**繁體中文** markdown 報告：

## 任務 1：資料健檢
- 列每個指標的非空天數 / 涵蓋率 / 資料起訖日期
- 識別資料密度斷層（連續 ≥ 7 天空值）
- 列出 |zscore30| > 3 的離群值日期（resting_hr / hrv_sdnn_ms / sleep_score）
- 建議「分析黃金窗口」

## 任務 2：核心 Readiness 三角（HRV × resting_hr × walking_hr_avg）
- 三者長期趨勢與相關性
- 識別「典型疲勞日」（HRV z<-1, RHR z>+1, walking_HR z>+1 同時成立）
- 識別「典型超恢復日」（HRV z>+1, RHR z<-1）
- **結論**一句話：身體目前在進步、平穩、還是累積疲勞

## 任務 3：睡眠 → 隔日恢復
- lag 1 天的 sleep_* × 今天 hrv_sdnn_ms / resting_hr 相關
- 比較三個假設：A 總時長 / B 深睡時長 / C 深睡 + REM 比
- **結論**：對這位使用者而言，睡眠的哪個面向最值得優化？

## 任務 4：步態力學
- walking_asymmetry_pct / double_support_pct / walking_speed_mps / step_length_cm 趨勢
- 識別「步態異常週」
- gait_efficiency = walking_speed_mps / walking_hr_avg 的長期趨勢
- 高步數日 vs 低步數日的步態差異

## 任務 5：環境與生理節律
- 日照時間分箱 → 當晚睡眠分數
- 月度 bedtime_hour 標準差（作息穩定性）
- 日照不足連續 ≥ 3 天 → 後續 HRV 變化
- 假日 vs 平日全指標差異

## 任務 6：Readiness Score 解讀
- 過去資料中分數 < 40（紅燈）和 > 75（綠燈）的日期分佈
- 最近 7 天主要驅動因素

## 任務 7：生病早警
- 警戒日（respiratory_rate_zscore30 > 1 AND wrist_temp_delta_c_zscore30 > 1）
- 警戒日後 7 天有沒有真的進展為發病模式
- 這個早警對歷史事件的敏感度

最後輸出 **INSIGHTS** 區塊：3-5 條最值得行動的整合建議。

務必：
- 每個任務最後一行給「**結論**」一句話
- 樣本太小或 p > 0.05 明說「資料不足以下結論」
- 結尾固定加：「⚠ 此為數據觀察，不構成醫療診斷；持續異常請就醫。」`;

// Map dashboard short keys → parse_health.py canonical names so the LLM sees
// one consistent schema regardless of which side parsed the data.
const NAME_MAP = {
  hr: "heart_rate_mean",
  hrv: "hrv_sdnn_ms",
  spo2: "spo2_mean",
  respiratory: "respiratory_rate",
  flights: "flights_climbed",
  distance: "distance_km",
  active_energy: "active_kcal",
  walking_hr: "walking_hr_avg",
  vo2max: "vo2_max",
  walking_asymmetry: "walking_asymmetry_pct",
  double_support: "double_support_pct",
  daylight: "daylight_minutes",
  sleep_hours: "sleep_total_h",
  sleep_deep_minutes: "sleep_deep_min",
  sleep_rem_minutes: "sleep_rem_min",
  sleep_awake_minutes: "sleep_awake_min",
};

function canonicalName(c) {
  if (NAME_MAP[c]) return NAME_MAP[c];
  // Also rename the matching baseline / zscore companions
  for (const [k, v] of Object.entries(NAME_MAP)) {
    if (c === `${k}_baseline30`) return `${v}_baseline30`;
    if (c === `${k}_zscore30`) return `${v}_zscore30`;
  }
  return c;
}

function fmtCell(v) {
  if (v == null) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    if (Number.isInteger(v)) return String(v);
    // 2 decimals, trim trailing zeros
    return v.toFixed(2).replace(/\.?0+$/, "");
  }
  return String(v);
}

// Compact CSV: skip cols with no finite values, rename to canonical, drop
// raw sleep_minutes/sleep_efficiency etc. that are redundant given _h cols.
function rowsToCsv(rows, columns, opts = {}) {
  const { excludeCols = [], includeBaselines = false } = opts;
  const skip = new Set([
    "sleep_start", "sleep_end",
    "sleep_minutes",
    ...excludeCols,
  ]);
  const cols = columns.filter(c => {
    if (skip.has(c)) return false;
    if (!includeBaselines && (c.endsWith("_baseline30") || c.endsWith("_zscore30"))) return false;
    // keep only cols with at least one finite value in the slice
    return rows.some(r => Number.isFinite(r[c]));
  });
  const header = ["date", ...cols.map(canonicalName)].join(",");
  const lines = rows.map(r => {
    return [r.date, ...cols.map(c => fmtCell(r[c]))].join(",");
  });
  return [header, ...lines].join("\n");
}

function summaryHeader(frame) {
  const last = frame.rows[frame.rows.length - 1] || {};
  const lines = [];
  if (Number.isFinite(last.readiness)) lines.push(`今日 Readiness：${last.readiness.toFixed(0)} / 100`);
  if (Number.isFinite(last.env_stress)) lines.push(`今日 Environment Stress：${last.env_stress.toFixed(0)} / 100`);
  return lines.join("\n");
}

export function buildCompactSummaryPrompt(frame, opts = {}) {
  const lookback = opts.lookback ?? 30;
  const recent = frame.rows.slice(-lookback);
  const csv = rowsToCsv(recent, frame.columns, { includeBaselines: true });
  const header = summaryHeader(frame);
  const user = [
    `以下是最近 ${recent.length} 天的健康資料寬表（CSV，含 30 天 baseline + z-score 衍生欄位）：`,
    "",
    "```csv",
    csv,
    "```",
    "",
    header && "**今日狀態快照**\n" + header,
    "",
    "請依系統指示輸出三段分析。",
  ].filter(Boolean).join("\n");
  return { system: COMPACT_SYSTEM, user };
}

// Build the persistent system prompt for the chatbot. Includes the recent
// 30 days CSV + today's snapshot. Sent once per turn alongside the rolling
// message history so the model always has direct data access without us
// having to pre-summarise every metric.
const CHAT_SYSTEM_RULES = `你是親切的健康數據分析助手。使用者上傳了 Apple Health 資料給儀表板分析，
他現在想跟你聊天問問題。你看得到他下面的健康資料原始 CSV，所以可以直接引用具體數字。

回答原則：
1. 使用者問什麼就答什麼，**不要主動展開到沒問的事**
2. 用繁體中文、白話、平易近人。**避免**「自律神經」「σ」「partial correlation」「Spearman」這類專業術語
3. 想引用數據時用具體數字（例：「你最近 7 天 HRV 平均 42ms，比平常少 4ms」）
4. 不確定 / 資料不夠時就明說「資料不夠」
5. **永遠不要做醫療診斷**。需要時建議看醫生
6. 預設回答 2-4 句就夠，使用者要求展開再展開
7. 提到「會不會生病 / 該不該吃藥 / 是不是有病」這類問題時，附一句「此為數據觀察，不構成醫療診斷」`;

export function buildChatSystem(frame, opts = {}) {
  const lookback = opts.lookback ?? 30;
  const recent = frame.rows.slice(-lookback);
  const csv = rowsToCsv(recent, frame.columns, { includeBaselines: true });
  const last = frame.rows[frame.rows.length - 1] || {};
  const headerLines = [];
  if (Number.isFinite(last.readiness)) headerLines.push(`今日 Readiness 分數：${last.readiness.toFixed(0)} / 100`);
  if (Number.isFinite(last.env_stress)) headerLines.push(`今日 Environment Stress：${last.env_stress.toFixed(0)} / 100`);
  if (last.date) headerLines.push(`最新一筆日期：${last.date}`);

  return `${CHAT_SYSTEM_RULES}

以下是使用者最近 ${recent.length} 天的每日健康指標（含 30 天滾動 baseline 與 z-score 衍生欄位）：

\`\`\`csv
${csv}
\`\`\`

${headerLines.length ? "**今日狀態快照**\n" + headerLines.join("\n") : ""}`;
}

// Multi-turn chat call — pass an array of {role, content} messages.
// Throws on non-2xx. Conversation history is the caller's responsibility.
export async function callMinimaxChat(messages, opts = {}) {
  const s = getSettings();
  if (!s.token) throw new Error("尚未填入 MiniMax token，請先到「設定」貼上");
  const url = endpointUrl(s);
  const body = {
    model: s.model,
    messages,
    max_tokens: opts.maxTokens ?? 1500,
    temperature: opts.temperature ?? 0.4,
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: authHeaders(s),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "(無回應)");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 600)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`回應格式異常：${JSON.stringify(data).slice(0, 600)}`);
  }
  return { content, raw: data };
}

export function buildDeepAnalysisPrompt(frame) {
  // Full window with baselines so the LLM has everything it needs in one shot.
  const csv = rowsToCsv(frame.rows, frame.columns, { includeBaselines: true });
  const header = summaryHeader(frame);
  const user = [
    `以下是分析期間 ${frame.rows.length} 天的完整每日寬表（含 30 天 baseline + z-score 衍生欄位，欄名已對齊 parse_health.py canonical schema）：`,
    "",
    "```csv",
    csv,
    "```",
    "",
    header && "**今日狀態快照**\n" + header,
    "",
    "請依系統指示輸出 7 個任務的完整 markdown 報告 + INSIGHTS 整合建議。",
  ].filter(Boolean).join("\n");
  return { system: DEEP_SYSTEM, user };
}
