// Local persistence: the processed dataset lives in IndexedDB so the user does
// not have to re-upload the (huge) export on every visit; settings and habits
// live in localStorage. Nothing ever leaves the device.

const DB_NAME = "autohealth";
const DB_VERSION = 1;
const STORE = "datasets";
const DATASET_KEY = "current";
export const DATASET_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function nanToNull(obj) { return JSON.parse(JSON.stringify(obj, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v))); }
function nullToNan(obj) {
  if (Array.isArray(obj)) return obj.map(nullToNan);
  if (obj && typeof obj === "object") { const o = {}; for (const [k, v] of Object.entries(obj)) o[k] = nullToNan(v); return o; }
  return obj === null ? NaN : obj;
}

export async function saveDataset(dataset) {
  try {
    const db = await openDb();
    const payload = { version: DATASET_VERSION, savedAt: Date.now(), data: nanToNull(dataset) };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(payload, DATASET_KEY);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch (e) {
    console.warn("saveDataset failed", e);
    return false;
  }
}

export async function loadDataset() {
  try {
    const db = await openDb();
    const payload = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(DATASET_KEY);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    db.close();
    if (!payload || payload.version !== DATASET_VERSION) return null;
    const data = payload.data;
    // frame rows: null -> NaN
    data.frame.rows = data.frame.rows.map((r) => { const o = { date: r.date }; for (const c of data.frame.columns) o[c] = r[c] == null ? NaN : r[c]; return o; });
    data.hourly = nullToNan(data.hourly || {});
    return { ...data, savedAt: payload.savedAt };
  } catch (e) {
    console.warn("loadDataset failed", e);
    return null;
  }
}

export async function clearDataset() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(DATASET_KEY);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* ignore */ }
}

// ---- localStorage helpers --------------------------------------------------

export function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
