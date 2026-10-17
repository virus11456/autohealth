// Tiny dependency-free SVG chart helpers. Responsive via viewBox; colours
// come from CSS variables so light/dark themes work without re-rendering.

const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, children = []) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const c of children) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}

function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const rough = span / count;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const steps = [1, 2, 2.5, 5, 10];
  let step = pow;
  for (const s of steps) { if (rough <= s * pow) { step = s * pow; break; } }
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

function fmtNum(v, digits) {
  if (!Number.isFinite(v)) return "—";
  if (digits != null) return v.toFixed(digits);
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}

function attachTooltip(container, svg, points, render) {
  // points: [{x (px), y (px), payload}]
  let tip = container.querySelector(".chart-tip");
  if (!tip) { tip = document.createElement("div"); tip.className = "chart-tip"; container.appendChild(tip); }
  let marker = svg.querySelector(".chart-marker");
  if (!marker) { marker = el("line", { class: "chart-marker" }); svg.appendChild(marker); }
  const hide = () => { tip.style.display = "none"; marker.style.display = "none"; };
  const move = (clientX) => {
    if (!points.length) return;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const x = (clientX - rect.left) * (vb.width / rect.width);
    let best = points[0], bd = Infinity;
    for (const p of points) { const d = Math.abs(p.x - x); if (d < bd) { bd = d; best = p; } }
    marker.setAttribute("x1", best.x); marker.setAttribute("x2", best.x);
    marker.setAttribute("y1", vb.y); marker.setAttribute("y2", vb.y + vb.height);
    marker.style.display = "";
    tip.innerHTML = render(best.payload);
    tip.style.display = "block";
    const px = (best.x / vb.width) * rect.width;
    tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, px - tip.offsetWidth / 2))}px`;
  };
  svg.onpointermove = (e) => move(e.clientX);
  svg.onpointerleave = hide;
  svg.ontouchstart = (e) => { if (e.touches[0]) move(e.touches[0].clientX); };
  hide();
}

/**
 * Line chart with optional band and goal line.
 * series: [{ values:[], color, name, dashed?, area? }], labels: [] (x labels)
 */
export function lineChart(container, { series, labels, band, goal, height = 200, yMin, yMax, digits, unit = "", yTicks = 4 }) {
  container.innerHTML = "";
  container.classList.add("chart");
  const W = 640, H = height, padL = 40, padR = 12, padT = 12, padB = 26;
  const n = labels.length;
  const all = [];
  for (const s of series) for (const v of s.values) if (Number.isFinite(v)) all.push(v);
  if (band) for (const v of [...band.low, ...band.high]) if (Number.isFinite(v)) all.push(v);
  if (Number.isFinite(goal)) all.push(goal);
  if (!all.length) { container.innerHTML = `<div class="empty-state">沒有資料</div>`; return; }
  let lo = yMin ?? Math.min(...all), hi = yMax ?? Math.max(...all);
  if (lo === hi) { lo -= 1; hi += 1; }
  if (yMin == null) lo -= (hi - lo) * 0.08;
  if (yMax == null) hi += (hi - lo) * 0.08;
  const xs = (i) => padL + (n <= 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
  const ys = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", preserveAspectRatio: "none" });

  for (const t of niceTicks(lo, hi, yTicks)) {
    svg.appendChild(el("line", { x1: padL, x2: W - padR, y1: ys(t), y2: ys(t), class: "grid" }));
    svg.appendChild(el("text", { x: padL - 6, y: ys(t) + 4, class: "tick", "text-anchor": "end" }, [fmtNum(t, digits)]));
  }
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    svg.appendChild(el("text", { x: xs(i), y: H - 8, class: "tick", "text-anchor": "middle" }, [labels[i]]));
  }
  if (band) {
    let d = "", back = "";
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(band.low[i]) || !Number.isFinite(band.high[i])) continue;
      d += `${d ? "L" : "M"}${xs(i)},${ys(band.high[i])} `;
      back = `L${xs(i)},${ys(band.low[i])} ` + back;
    }
    if (d) svg.appendChild(el("path", { d: d + back + "Z", fill: band.color || "var(--accent)", opacity: 0.12 }));
  }
  if (Number.isFinite(goal)) {
    svg.appendChild(el("line", { x1: padL, x2: W - padR, y1: ys(goal), y2: ys(goal), class: "goal-line" }));
  }
  const points = [];
  series.forEach((s, si) => {
    let d = "", areaD = "";
    let open = false;
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) { open = false; continue; }
      d += `${open ? "L" : "M"}${xs(i)},${ys(v)} `;
      open = true;
      if (si === 0) points.push({ x: xs(i), y: ys(v), payload: { i, label: labels[i] } });
    }
    if (s.area && d) {
      const first = s.values.findIndex(Number.isFinite);
      let last = n - 1; while (last >= 0 && !Number.isFinite(s.values[last])) last--;
      areaD = d + `L${xs(last)},${ys(lo)} L${xs(first)},${ys(lo)} Z`;
      svg.appendChild(el("path", { d: areaD, fill: s.color, opacity: 0.15 }));
    }
    svg.appendChild(el("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width || 2.2,
      "stroke-dasharray": s.dashed ? "5 4" : null, "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" }));
    if (s.dots) {
      for (let i = 0; i < n; i++) if (Number.isFinite(s.values[i])) svg.appendChild(el("circle", { cx: xs(i), cy: ys(s.values[i]), r: 2.4, fill: s.color }));
    }
  });
  container.appendChild(svg);
  attachTooltip(container, svg, points, ({ i, label }) => {
    const rows = series.map((s) => `<div><span class="dot" style="background:${s.color}"></span>${s.name}: <b>${fmtNum(s.values[i], digits)}${unit}</b></div>`);
    return `<div class="tip-title">${label}</div>${rows.join("")}`;
  });
}

/**
 * Bar chart. values: [], labels: [], colorFn(value, i) -> css colour
 */
export function barChart(container, { values, labels, colorFn, goal, height = 180, yMax, digits, unit = "", onClick, highlight }) {
  container.innerHTML = "";
  container.classList.add("chart");
  const W = 640, H = height, padL = 36, padR = 8, padT = 10, padB = 26;
  const n = values.length;
  const fin = values.filter(Number.isFinite);
  if (!fin.length) { container.innerHTML = `<div class="empty-state">沒有資料</div>`; return; }
  const hi = yMax ?? Math.max(...fin, Number.isFinite(goal) ? goal : -Infinity) * 1.08;
  const lo = 0;
  const plotW = W - padL - padR;
  const slot = plotW / Math.max(1, n);
  const bw = Math.max(2, slot * 0.68);
  const ys = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", preserveAspectRatio: "none" });
  for (const t of niceTicks(lo, hi, 3)) {
    svg.appendChild(el("line", { x1: padL, x2: W - padR, y1: ys(t), y2: ys(t), class: "grid" }));
    svg.appendChild(el("text", { x: padL - 6, y: ys(t) + 4, class: "tick", "text-anchor": "end" }, [fmtNum(t, digits)]));
  }
  const step = Math.max(1, Math.ceil(n / 7));
  const points = [];
  for (let i = 0; i < n; i++) {
    const x = padL + i * slot + (slot - bw) / 2;
    if (i % step === 0 || n <= 10) svg.appendChild(el("text", { x: x + bw / 2, y: H - 8, class: "tick", "text-anchor": "middle" }, [labels[i]]));
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const rect = el("rect", { x, y: ys(v), width: bw, height: Math.max(1, ys(lo) - ys(v)), rx: Math.min(4, bw / 2),
      fill: colorFn ? colorFn(v, i) : "var(--accent)", class: highlight === i ? "bar hl" : "bar" });
    if (onClick) rect.addEventListener("click", () => onClick(i));
    svg.appendChild(rect);
    points.push({ x: x + bw / 2, y: ys(v), payload: { i } });
  }
  if (Number.isFinite(goal)) svg.appendChild(el("line", { x1: padL, x2: W - padR, y1: ys(goal), y2: ys(goal), class: "goal-line" }));
  container.appendChild(svg);
  attachTooltip(container, svg, points, ({ i }) => `<div class="tip-title">${labels[i]}</div><div><b>${fmtNum(values[i], digits)}${unit}</b></div>`);
}

/** Donut ring with centre text. */
export function ring(container, { value, max = 100, color = "var(--accent)", size = 120, stroke = 11, label, sub, track }) {
  container.innerHTML = "";
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Number.isFinite(value) ? Math.max(0, Math.min(1, value / max)) : 0;
  const svg = el("svg", { viewBox: `0 0 ${size} ${size}`, class: "ring-svg", width: size, height: size });
  svg.appendChild(el("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: track || "var(--ring-track)", "stroke-width": stroke }));
  svg.appendChild(el("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: color, "stroke-width": stroke,
    "stroke-linecap": "round", "stroke-dasharray": `${c * pct} ${c}`, transform: `rotate(-90 ${size / 2} ${size / 2})`, class: "ring-fill" }));
  svg.appendChild(el("text", { x: size / 2, y: size / 2 + (sub ? 2 : 7), class: "ring-value", "text-anchor": "middle" }, [label ?? (Number.isFinite(value) ? String(Math.round(value)) : "—")]));
  if (sub) svg.appendChild(el("text", { x: size / 2, y: size / 2 + 20, class: "ring-sub", "text-anchor": "middle" }, [sub]));
  container.appendChild(svg);
}

/** 24 coloured hour columns for the intraday stress timeline. */
export function stressTimeline(container, intraday, { height = 120, levelColor } = {}) {
  container.innerHTML = "";
  container.classList.add("chart");
  const W = 640, H = height, padL = 8, padR = 8, padT = 6, padB = 22;
  const slot = (W - padL - padR) / 24;
  const bw = slot * 0.72;
  const ys = (v) => padT + (1 - v / 100) * (H - padT - padB);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", preserveAspectRatio: "none" });
  for (const t of [25, 50, 75]) svg.appendChild(el("line", { x1: padL, x2: W - padR, y1: ys(t), y2: ys(t), class: "grid" }));
  const points = [];
  intraday.forEach((h, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    if (i % 3 === 0) svg.appendChild(el("text", { x: x + bw / 2, y: H - 6, class: "tick", "text-anchor": "middle" }, [`${i}`]));
    let fill, y, hgt;
    if (h.state === "sleep") { fill = "var(--sleep)"; y = ys(Number.isFinite(h.stress) ? Math.max(h.stress, 8) : 15); hgt = ys(0) - y; }
    else if (h.state === "workout") { fill = "var(--workout)"; y = ys(85); hgt = ys(0) - y; }
    else if (h.state === "awake" && Number.isFinite(h.stress)) { fill = levelColor(h.stress); y = ys(Math.max(h.stress, 4)); hgt = ys(0) - y; }
    else { fill = "var(--ring-track)"; y = ys(3); hgt = ys(0) - y; }
    svg.appendChild(el("rect", { x, y, width: bw, height: Math.max(1, hgt), rx: 3, fill, opacity: h.state === "none" ? 0.5 : 1 }));
    points.push({ x: x + bw / 2, y, payload: h });
  });
  container.appendChild(svg);
  attachTooltip(container, svg, points, (h) => {
    const st = { sleep: "睡眠", workout: "運動", awake: "清醒", none: "無資料" }[h.state];
    return `<div class="tip-title">${String(h.hour).padStart(2, "0")}:00–${String(h.hour + 1).padStart(2, "0")}:00 · ${st}</div>` +
      (Number.isFinite(h.stress) ? `<div>壓力 <b>${h.stress.toFixed(0)}</b></div>` : "") +
      (Number.isFinite(h.hr) ? `<div>心率 <b>${h.hr.toFixed(0)} bpm</b></div>` : "");
  });
}

/** Body Battery intraday area curve. */
export function batteryCurve(container, curve, intraday, { height = 150 } = {}) {
  const labels = curve.map((_, i) => `${i}`);
  lineChart(container, {
    series: [{ values: curve, color: "var(--battery)", name: "Body Battery", area: true, width: 2.6 }],
    labels, height, yMin: 0, yMax: 100, digits: 0, unit: "%", yTicks: 4,
  });
  // overlay sleep shading
  const svg = container.querySelector("svg");
  if (!svg || !intraday) return;
  const vb = svg.viewBox.baseVal;
  const padL = 40, padR = 12, padT = 12, padB = 26;
  const plotW = vb.width - padL - padR;
  intraday.forEach((h, i) => {
    if (h.state !== "sleep" && h.state !== "workout") return;
    const x = padL + (i / 23) * plotW;
    const rect = el("rect", { x: x - plotW / 46, y: padT, width: plotW / 23, height: vb.height - padT - padB,
      fill: h.state === "sleep" ? "var(--sleep)" : "var(--workout)", opacity: 0.12 });
    svg.insertBefore(rect, svg.firstChild);
  });
}

/** Horizontal stacked bar for sleep stages. */
export function stageBar(container, segments) {
  // segments: [{label, minutes, color}]
  container.innerHTML = "";
  const total = segments.reduce((s, x) => s + (Number.isFinite(x.minutes) ? x.minutes : 0), 0);
  if (!total) { container.innerHTML = `<div class="muted">沒有睡眠階段資料</div>`; return; }
  const bar = document.createElement("div"); bar.className = "stage-bar";
  const legend = document.createElement("div"); legend.className = "stage-legend";
  for (const s of segments) {
    if (!Number.isFinite(s.minutes) || s.minutes <= 0) continue;
    const seg = document.createElement("div"); seg.style.flex = String(s.minutes); seg.style.background = s.color; seg.title = `${s.label} ${Math.round(s.minutes)} 分`;
    bar.appendChild(seg);
    const li = document.createElement("span"); li.innerHTML = `<i style="background:${s.color}"></i>${s.label} ${Math.round(s.minutes)} 分 (${(s.minutes / total * 100).toFixed(0)}%)`;
    legend.appendChild(li);
  }
  container.appendChild(bar); container.appendChild(legend);
}

/** Correlation matrix as a coloured HTML grid. */
export function heatGrid(container, { labels, matrix }) {
  container.innerHTML = "";
  const n = labels.length;
  const table = document.createElement("table"); table.className = "heat";
  const thead = document.createElement("thead");
  thead.innerHTML = `<tr><th></th>${labels.map((l) => `<th><span>${l}</span></th>`).join("")}</tr>`;
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (let i = 0; i < n; i++) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<th>${labels[i]}</th>` + matrix[i].map((v, j) => {
      if (!Number.isFinite(v)) return `<td></td>`;
      const a = Math.min(1, Math.abs(v));
      const bg = v >= 0 ? `rgba(79,140,255,${0.08 + a * 0.75})` : `rgba(239,68,68,${0.08 + a * 0.75})`;
      return `<td style="background:${bg}" title="${labels[i]} ↔ ${labels[j]}: ${v.toFixed(2)}">${i === j ? "" : v.toFixed(2)}</td>`;
    }).join("");
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}
