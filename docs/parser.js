// Stream-parse Apple Health export.xml entirely in the browser.
// Handles .zip (via fflate streaming Unzip) and raw .xml. Memory stays
// bounded throughout: zip bytes are pushed in chunks, fflate inflates
// chunk-by-chunk into a ReadableStream that the line parser consumes
// incrementally. A 1.6 GB inflated XML never sits in memory whole.

const SUPPORTED = [
  { key: "steps",         hk: "HKQuantityTypeIdentifierStepCount",                  label: "步數",            unit: "步",         agg: "sum"  },
  { key: "active_energy", hk: "HKQuantityTypeIdentifierActiveEnergyBurned",         label: "活動消耗",        unit: "kcal",       agg: "sum"  },
  { key: "distance",      hk: "HKQuantityTypeIdentifierDistanceWalkingRunning",     label: "步行距離",        unit: "km",         agg: "sum"  },
  { key: "flights",       hk: "HKQuantityTypeIdentifierFlightsClimbed",             label: "爬樓層",          unit: "層",         agg: "sum"  },
  { key: "hr",            hk: "HKQuantityTypeIdentifierHeartRate",                  label: "平均心率",        unit: "bpm",        agg: "mean" },
  { key: "resting_hr",    hk: "HKQuantityTypeIdentifierRestingHeartRate",           label: "靜息心率",        unit: "bpm",        agg: "mean" },
  { key: "walking_hr",    hk: "HKQuantityTypeIdentifierWalkingHeartRateAverage",    label: "步行心率",        unit: "bpm",        agg: "mean" },
  { key: "hrv",           hk: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",   label: "HRV",             unit: "ms",         agg: "mean" },
  { key: "spo2",          hk: "HKQuantityTypeIdentifierOxygenSaturation",           label: "血氧 (日均)",     unit: "%",          agg: "mean" },
  { key: "respiratory",   hk: "HKQuantityTypeIdentifierRespiratoryRate",            label: "呼吸頻率",        unit: "次/分",      agg: "mean" },
  { key: "body_temp",     hk: "HKQuantityTypeIdentifierBodyTemperature",            label: "體溫",            unit: "°C",         agg: "mean" },
  { key: "vo2max",        hk: "HKQuantityTypeIdentifierVO2Max",                     label: "VO2 Max",         unit: "ml/kg·min",  agg: "mean" },
  { key: "walking_asymmetry",  hk: "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",     label: "步行不對稱率",  unit: "%",          agg: "mean" },
  { key: "double_support",     hk: "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage", label: "雙腳支撐時間",  unit: "%",          agg: "mean" },
  { key: "daylight",           hk: "HKQuantityTypeIdentifierTimeInDaylight",                 label: "日照時間",      unit: "分鐘",       agg: "sum"  },
  // New in Phase 5 prep — names align with scripts/parse_health.py canonical schema
  { key: "hr_recovery_1min",   hk: "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute",     label: "1 分鐘心率恢復", unit: "bpm",        agg: "mean" },
  { key: "wrist_temp_delta_c", hk: "HKQuantityTypeIdentifierAppleSleepingWristTemperature",  label: "睡眠手腕溫差",  unit: "°C",         agg: "mean" },
  { key: "walking_speed_mps",  hk: "HKQuantityTypeIdentifierWalkingSpeed",                   label: "步行速度",      unit: "m/s",        agg: "mean" },
  { key: "step_length_cm",     hk: "HKQuantityTypeIdentifierWalkingStepLength",              label: "步長",          unit: "cm",         agg: "mean" },
  { key: "walking_steadiness", hk: "HKQuantityTypeIdentifierAppleWalkingSteadiness",         label: "步行穩定度",    unit: "%",          agg: "mean" },
  { key: "six_min_walk_m",     hk: "HKQuantityTypeIdentifierSixMinuteWalkTestDistance",      label: "6 分鐘步行距離", unit: "m",          agg: "mean" },
  { key: "basal_kcal",         hk: "HKQuantityTypeIdentifierBasalEnergyBurned",              label: "基礎代謝",      unit: "kcal",       agg: "sum"  },
  { key: "exercise_minutes",   hk: "HKQuantityTypeIdentifierAppleExerciseTime",              label: "運動時間",      unit: "分鐘",       agg: "sum"  },
  { key: "stand_minutes",      hk: "HKQuantityTypeIdentifierAppleStandTime",                 label: "站立時間",      unit: "分鐘",       agg: "sum"  },
  { key: "headphone_db",       hk: "HKQuantityTypeIdentifierHeadphoneAudioExposure",         label: "耳機音量",      unit: "dB",         agg: "mean" },
  { key: "env_audio_db",       hk: "HKQuantityTypeIdentifierEnvironmentalAudioExposure",     label: "環境音量",      unit: "dB",         agg: "mean" },
  { key: "body_mass_kg",       hk: "HKQuantityTypeIdentifierBodyMass",                       label: "體重",          unit: "kg",         agg: "mean" },
  { key: "bmi",                hk: "HKQuantityTypeIdentifierBodyMassIndex",                  label: "BMI",           unit: "",           agg: "mean" },
];

const SLEEP_HK = "HKCategoryTypeIdentifierSleepAnalysis";
const HK_INDEX = Object.fromEntries(SUPPORTED.map((m) => [m.hk, m]));

export const SUPPORTED_METRICS = SUPPORTED;
export const METRIC_BY_KEY = Object.fromEntries(SUPPORTED.map((m) => [m.key, m]));

// Apple writes dates like "2024-09-12 23:55:21 +0800". JS Date can't parse the
// trailing-offset form reliably, so normalize "YYYY-MM-DD HH:mm:ss +HHMM" -> ISO.
function parseAppleDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*([+-]\d{2})(\d{2}))?/);
  if (!m) return null;
  const iso = m[7] != null
    ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8]}`
    : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

// Apple decodes XML entities in attribute values; we get them post-decode from
// our regex, but `value` can legitimately contain " in source names. We use a
// non-greedy attribute matcher that handles either "..." or '...'.
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function parseAttrs(s) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(s)) !== null) {
    out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

// Match a <Record> opening tag, whether self-closing or wrapping children.
// Apple Health emits self-closing <Record .../> for plain readings, but HRV
// always has <HeartRateVariabilityMetadataList> children, and many SpO2 /
// sleep / heart-rate records carry <MetadataEntry> children — so we accept
// both `/>` and `>`. We only need the attributes from the opening tag; any
// children and the closing </Record> are ignored.
const RECORD_RE = /<Record\b([^>]*?)\/?>/g;

async function* streamLines(stream) {
  // Yields strings broken at newlines; preserves trailing partial buffer.
  const reader = stream.pipeThrough(new TextDecoderStream("utf-8")).getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (buf.length) yield buf;
      return;
    }
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
}

// Apple translates the export filename per device locale.
const KNOWN_EXPORT_NAMES = ["export.xml", "輸出.xml", "导出.xml", "エクスポート.xml"];

// fflate decodes zip entry names as Latin-1 when the spec's UTF-8 flag bit
// (0x800) isn't set, but macOS/iOS-created zips often store UTF-8 bytes in the
// header without setting the flag — the user sees mojibake like
// "apple_health_export/è¼¸å‡º.xml" for what should be "apple_health_export/輸出.xml".
// Recover by re-encoding the string as Latin-1 bytes and decoding them as UTF-8.
function decodeName(name) {
  if (!/[\x80-\xff]/.test(name)) return name;
  try {
    const bytes = new Uint8Array(name.length);
    for (let i = 0; i < name.length; i++) {
      const c = name.charCodeAt(i);
      if (c > 0xff) return name;
      bytes[i] = c;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return name;
  }
}

function isExportEntry(name) {
  return KNOWN_EXPORT_NAMES.includes(decodeName(name).split("/").pop());
}

// Stream the matching export.xml entry out of a zip without ever holding the
// inflated file in memory. fflate's Unzip is push-based: we feed it zip bytes
// as we read them; for each entry header it sees, onfile fires synchronously.
// We selectively call entry.start() on the matching entry and route its
// inflated chunks into a ReadableStream that the rest of the pipeline reads.
async function getXmlStream(file, onProgress) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (!isZip) {
    return { stream: file.stream(), totalBytes: file.size };
  }
  if (typeof fflate === "undefined") {
    throw new Error("fflate 未載入，無法解 zip");
  }
  onProgress && onProgress({ phase: "unzip", message: "解壓縮中…" });

  return new Promise((resolveReady, rejectReady) => {
    const seenXmls = [];
    let matched = null;
    let streamController = null;
    let resumePump = null;
    const wakeup = () => { const r = resumePump; resumePump = null; if (r) r(); };

    // 4 MB cap on the inflated queue keeps memory bounded even when fflate
    // outpaces the line parser.
    const xmlStream = new ReadableStream({
      start(c) { streamController = c; },
      pull() { wakeup(); },
    }, new ByteLengthQueuingStrategy({ highWaterMark: 4 * 1024 * 1024 }));

    const unzipper = new fflate.Unzip((entry) => {
      if (entry.name.toLowerCase().endsWith(".xml")) seenXmls.push(decodeName(entry.name));
      if (matched) return;
      if (!isExportEntry(entry.name)) return;
      matched = entry.name;
      entry.ondata = (err, chunk, final) => {
        if (err) { streamController.error(err); return; }
        // chunk may be reused by fflate on the next callback; copy.
        streamController.enqueue(new Uint8Array(chunk));
        if (final) streamController.close();
      };
      entry.start();
      resolveReady({ stream: xmlStream, totalBytes: entry.originalSize || 0 });
    });
    unzipper.register(fflate.UnzipInflate);

    (async () => {
      const reader = file.stream().getReader();
      let bytesRead = 0;
      let lastTick = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            unzipper.push(new Uint8Array(0), true);
            break;
          }
          unzipper.push(value, false);
          bytesRead += value.byteLength;
          // pause until consumer drains below highWaterMark
          while (matched && streamController.desiredSize !== null && streamController.desiredSize <= 0) {
            await new Promise((res) => { resumePump = res; });
          }
          const now = Date.now();
          if (onProgress && !matched && now - lastTick > 100) {
            lastTick = now;
            onProgress({
              phase: "unzip",
              message: "解壓縮中…",
              progress: file.size ? bytesRead / file.size : null,
            });
          }
        }
        if (!matched) {
          rejectReady(new Error(
            `zip 內找不到 export.xml；zip 中的 .xml 檔：${seenXmls.length ? seenXmls.join(", ") : "(無)"}`,
          ));
        }
      } catch (e) {
        if (matched) streamController.error(e);
        else rejectReady(e);
      }
    })();
  });
}

// Date key from a Date in local time (YYYY-MM-DD). Mirrors the helper in
// aggregator.js — used to bucket records into per-day accumulators during
// the streaming-aggregate parse.
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const PERCENT_KEYS = ["spo2", "walking_asymmetry", "double_support", "walking_steadiness"];

// Streaming-aggregate parser. Instead of accumulating every <Record> into
// arrays and aggregating after parse (which can hit ~100 MB+ for heavy users
// and crash iOS Safari), update a per-day accumulator immediately and throw
// the raw record away. Memory stays in the low MB range regardless of input
// size.
//
// Returns: {
//   dailyAggs:  Map<dateKey, Map<metricKey, { sum, count, min, max, sumSq }>>
//   sleep:      [{ start, end, stage, source }]   // kept full — small set
//   spo2Raw:    [{ start, value }]                // kept full for sleep-min interval join
//   percentMax: { spo2: number, walking_asymmetry: ..., ... }  // for fraction-form detection
//   recordCount: number
// }
export async function parseExport(file, onProgress) {
  const dailyAggs = new Map();
  const sleep = [];
  const spo2Raw = [];
  const percentMax = Object.fromEntries(PERCENT_KEYS.map((k) => [k, -Infinity]));

  function getAcc(dKey, mKey) {
    let dayMap = dailyAggs.get(dKey);
    if (!dayMap) { dayMap = new Map(); dailyAggs.set(dKey, dayMap); }
    let acc = dayMap.get(mKey);
    if (!acc) {
      acc = { sum: 0, count: 0, min: Infinity, max: -Infinity, sumSq: 0 };
      dayMap.set(mKey, acc);
    }
    return acc;
  }

  const { stream, totalBytes } = await getXmlStream(file, onProgress);
  let bytesSeen = 0;
  let recordCount = 0;
  let lastTick = 0;

  for await (const line of streamLines(stream)) {
    bytesSeen += line.length + 1;
    const now = Date.now();
    if (onProgress && now - lastTick > 100) {
      lastTick = now;
      onProgress({
        phase: "parse",
        message: `解析中… ${recordCount.toLocaleString()} 筆紀錄`,
        progress: totalBytes ? bytesSeen / totalBytes : null,
      });
    }
    if (line.indexOf("<Record") === -1) continue;
    RECORD_RE.lastIndex = 0;
    let m;
    while ((m = RECORD_RE.exec(line)) !== null) {
      const attrs = parseAttrs(m[1]);
      const t = attrs.type;
      if (!t) continue;
      const start = parseAppleDate(attrs.startDate);
      const end = parseAppleDate(attrs.endDate);
      if (!start || !end) continue;

      if (t === SLEEP_HK) {
        const stage = (attrs.value || "").replace("HKCategoryValueSleepAnalysis", "");
        sleep.push({ start, end, stage, source: attrs.sourceName || "" });
        recordCount++;
        continue;
      }

      const spec = HK_INDEX[t];
      if (!spec) continue;
      const v = parseFloat(attrs.value);
      if (!Number.isFinite(v)) continue;

      let value = v;
      if (spec.key === "distance") {
        const u = (attrs.unit || "").toLowerCase();
        if (u === "m" || u === "meter" || u === "metre") value = v / 1000;
      }

      // SpO2 raw kept for sleep-window interval join after parse.
      if (spec.key === "spo2") spo2Raw.push({ start, value });

      // Track max for fraction-form percent metrics — used to decide
      // whether to scale ×100 at finalize.
      if (spec.key in percentMax && value > percentMax[spec.key]) {
        percentMax[spec.key] = value;
      }

      // Fold into per-day accumulator and discard the raw record.
      const dKey = dateKey(start);
      const acc = getAcc(dKey, spec.key);
      acc.sum += value;
      acc.count++;
      if (value < acc.min) acc.min = value;
      if (value > acc.max) acc.max = value;
      acc.sumSq += value * value;

      recordCount++;
    }
  }

  // Apply fraction → percent normalization to accumulators in-place.
  // Linear scaling: multiply sum, sumSq scales as ×10000, min/max ×100.
  for (const key of PERCENT_KEYS) {
    const maxV = percentMax[key];
    if (!Number.isFinite(maxV) || maxV > 1.5) continue;
    for (const dayMap of dailyAggs.values()) {
      const acc = dayMap.get(key);
      if (!acc) continue;
      acc.sum *= 100;
      acc.sumSq *= 10000;
      acc.min *= 100;
      acc.max *= 100;
    }
    if (key === "spo2") for (const r of spo2Raw) r.value *= 100;
  }

  sleep.sort((a, b) => a.start - b.start);
  spo2Raw.sort((a, b) => a.start - b.start);

  onProgress && onProgress({
    phase: "done",
    message: `解析完成：${recordCount.toLocaleString()} 筆紀錄`,
    progress: 1,
  });

  return { dailyAggs, sleep, spo2Raw, percentMax, recordCount };
}
