const $ = (sel) => document.querySelector(sel);
const API = typeof window.PCIEWATCH_API === "string" ? window.PCIEWATCH_API : "";
const STATIC = !!window.PCIEWATCH_STATIC;

let trace = null;
let selected = null;
let activeTab = "tree";
let decodedPackets = [];
let timelineZoom = 1;
let showPhases = true;

const PALETTE = ["#4da3ff", "#a97bff", "#2fd0b4", "#f0b429", "#ef8354", "#7ad1a3",
                 "#e26fa6", "#6ec6ff", "#c9b458", "#8f9bb3"];

init();

async function init() {
  $("#load").onclick = loadTrace;
  $("#scenario").onchange = async () => { syncDefaults(); await loadTrace(); };
  $("#openDecode").onclick = () => { $("#decodeModal").classList.remove("hidden"); };
  $("#openModel").onclick = openModel;
  $("#closeModel").onclick = () => { stopAuto(); $("#modelModal").classList.add("hidden"); };
  $("#closeField").onclick = () => $("#fieldModal").classList.add("hidden");
  $("#fieldModal").onclick = (e) => {
    if (e.target.id === "fieldModal") $("#fieldModal").classList.add("hidden");
  };
  $("#modelPkt").onchange = onModelPktChange;
  $("#closeDecode").onclick = () => { $("#decodeModal").classList.add("hidden"); };
  $("#decodeBtn").onclick = decodePackets;
  $("#decodeFile").onchange = loadDecodeFile;
  document.querySelectorAll("#tabs button").forEach((b) => {
    b.onclick = () => {
      activeTab = b.dataset.tab;
      document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
      renderDetailTab();
    };
  });
  $("#decodeInput").value = "45000000 0100FFFF 00000000 00000000 00000000";
  $("#zoom").oninput = (e) => {
    timelineZoom = Number(e.target.value);
    $("#zoomVal").textContent = timelineZoom + "×";
    if (trace) renderTimeline();
  };
  $("#phaseToggle").onchange = (e) => {
    showPhases = e.target.checked;
    if (trace) renderTimeline();
  };
  $("#timeline").addEventListener("click", (e) => {
    if (!e.target.closest(".ev")) clearFlow();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") clearFlow();
  });
  $("#stepPrev").onclick = () => { stopAuto(); setModelStep(modelStep - 1); };
  $("#stepNext").onclick = () => { stopAuto(); setModelStep(modelStep + 1); };
  $("#stepReset").onclick = () => { stopAuto(); setModelStep(0); };
  $("#stepAuto").onclick = toggleAuto;
  $("#stepRange").oninput = (e) => { stopAuto(); setModelStep(Number(e.target.value)); };
  document.addEventListener("keydown", (e) => {
    if ($("#modelModal").classList.contains("hidden")) return;
    if (e.key === "ArrowRight") { stopAuto(); setModelStep(modelStep + 1); }
    else if (e.key === "ArrowLeft") { stopAuto(); setModelStep(modelStep - 1); }
  });
  await loadScenarios();
  await loadTrace();
}

async function loadScenarios() {
  try {
    const res = await fetch(API + "/scenarios.json");
    const data = await res.json();
    $("#scenario").innerHTML = data.scenarios.map(
      (s) => `<option value="${s.id}" data-gen="${s.gen}" data-width="${s.width}">${s.id} — ${s.desc}</option>`
    ).join("");
    syncDefaults();
  } catch (e) {
    $("#scenario").innerHTML = `<option value="enumeration">enumeration</option>`;
  }
}

function syncDefaults() {
  const opt = $("#scenario").selectedOptions[0];
  if (!opt) return;
  $("#gen").value = opt.dataset.gen || "";
  $("#width").value = opt.dataset.width || "";
}

async function loadTrace() {
  const scenario = $("#scenario").value || "enumeration";
  const gen = $("#gen").value;
  const width = $("#width").value;
  const res = await fetch(API + "/" + scenario + ".json");
  trace = await res.json();
  // 新 trace 与服务端数据不同源，关闭模型弹窗避免显示旧报文
  stopAuto();
  $("#modelModal").classList.add("hidden");
  // 事件密集的训练类场景默认放大，保证每个块都能看清
  timelineZoom = trace.events.length > 80 ? 2 : 1;
  if ($("#zoom")) {
    $("#zoom").value = timelineZoom;
    $("#zoomVal").textContent = timelineZoom + "×";
  }
  selected = null;
  renderSidebar();
  renderTimeline();
  $("#detailTitle").textContent = "事件详情";
  $("#detail").innerHTML = `<p class="empty">点击时序图中的报文查看分层解码结果。</p>`;
  const first = trace.events.find((e) => e.packet);
  if (first) selectEvent(first, false);
}

function renderSidebar() {
  const m = trace.meta;
  $("#meta").innerHTML = [
    ["Scenario", trace.scenario],
    ["Gen", `Gen${m.gen} · ${m.gen_rate_gts} GT/s`],
    ["Lanes", `x${m.width}`],
    ["Encoding", m.encoding],
    ["Mode", m.mode],
    ["Duration", `${trace.duration_ns} ns`],
    ["Events", trace.events.length],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

  $("#stats").innerHTML = `
    <div class="stat ok"><span class="n">${trace.counts.ok || 0}</span><span class="l">OK</span></div>
    <div class="stat warn"><span class="n">${trace.counts.warn || 0}</span><span class="l">WARN</span></div>
    <div class="stat error"><span class="n">${trace.counts.error || 0}</span><span class="l">ERROR</span></div>`;

  const list = $("#checks");
  const items = trace.checks;
  if (!items.length) {
    list.innerHTML = `<li class="ok">没有发现警告或错误</li>`;
  } else {
    list.innerHTML = items.map((c) =>
      `<li class="${c.level}" title="${escapeAttr(c.summary || "")}"><b>${c.code}</b><br>${c.text}</li>`
    ).join("");
  }
}

const MIN_BLOCK = 28;   // 事件块最小宽度（px），保证类型名可读
const LANE_H = 22;      // 每条策略子行的高度
const CHAR_W = 5.4;     // 9px 等宽字体的单字符宽度
const LABEL_W = 88;     // 左侧泳道标题列宽

// 泳道按“端点 + 方向”拆分，TX/RX 各占一行，直观体现收发方向
function timelineLanes() {
  const dirOf = (e) => (["TX", "RX", "→", "←"].includes(e.dir) ? e.dir : "");
  const out = [];
  trace.rows.forEach((row) => {
    if (row === "STATE") {
      out.push({ row, dir: "", label: row });
      return;
    }
    const evs = trace.events.filter((e) => e.row === row);
    ["TX", "RX", "→", "←"].forEach((d) => {
      if (evs.some((e) => dirOf(e) === d)) out.push({ row, dir: d, label: row });
    });
    if (evs.some((e) => !dirOf(e))) out.push({ row, dir: "", label: row });
  });
  return out;
}

function dirTag(dir) {
  if (dir === "TX") return `<i class="dirtag tx">▸TX</i>`;
  if (dir === "RX") return `<i class="dirtag rx">◂RX</i>`;
  if (dir === "→") return `<i class="dirtag tx">→</i>`;
  if (dir === "←") return `<i class="dirtag rx">←</i>`;
  return `<i class="dirtag wire">⇄</i>`;
}

const PHASE_TEXT = {
  link: "链路训练", fc: "流控初始化", cfg: "配置 / 枚举",
  data: "数据传输", pm: "低功耗", other: "链路维护",
};

// 阶段条：把链路训练 / 流控初始化 / 配置枚举 / 数据传输等归档区间画在时序图顶部
function renderPhaseRow(dur, total) {
  const phases = trace.phases || [];
  if (!phases.length) return "";
  const segs = phases.map((p) => {
    const left = (p.start_ns / dur) * total;
    const w = Math.max(8, ((p.end_ns - p.start_ns) / dur) * total);
    const name = p.label || PHASE_TEXT[p.key] || p.key;
    const maxChars = Math.max(0, Math.floor((w - 10) / 5.2));
    const label = maxChars >= 2 ? name.slice(0, maxChars) : "";
    const tip = `${p.label} · ${p.start_ns}–${p.end_ns} ns · ${p.events} 个事件\n${p.detail}`;
    return `<div class="tl-phase ${p.kind || p.key}" style="left:${left.toFixed(1)}px;width:${w.toFixed(1)}px" ` +
      `title="${escapeAttr(tip)}">${escapeHtml(label)}</div>`;
  }).join("");
  return `<div class="tl-row tl-phaserow"><div class="tl-rowlabel"><span>阶段</span></div>` +
    `<div class="tl-phasebar" style="width:${total}px">${segs}</div></div>`;
}

// 端到端路径：双击事件后高亮同一条 TLP / DLLP 在各层/两端的全部副本，并用箭头串接
let flowSvg = null;
let activeFlow = null;   // 当前展示的端到端链路（按时间升序的事件列表）

function clearFlow() {
  if (flowSvg) { flowSvg.remove(); flowSvg = null; }
  document.querySelectorAll(".ev.hl").forEach((el) => el.classList.remove("hl"));
  if (activeFlow) {
    activeFlow = null;
    if (selected) renderDetailTab();
  }
}

// 同一条报文 = 共享同一 flow 编号的全部事件
function flowGroup(ev) {
  if (ev.flow === undefined || ev.flow === null) return [];
  return trace.events.filter((e) => e.flow === ev.flow)
    .sort((a, b) => a.raw_t_ns - b.raw_t_ns || a.id - b.id);
}

// 每一步的关键属性：取报文解码结果中与链路时序相关的字段
function stepAttrs(e) {
  const p = e.packet || {};
  const v = p.values || {};
  const out = [];
  if (v.credit_class) out.push(v.credit_class);
  if (v.vc !== undefined) out.push(`VC${v.vc}`);
  if (v.hdr_fc !== undefined) out.push(`HdrFC=${v.hdr_fc}`);
  if (v.data_fc !== undefined) out.push(`DataFC=${v.data_fc}`);
  if (v.seq !== undefined) out.push(`Seq=${v.seq}`);
  if (v.rate_gts !== undefined) out.push(`${v.rate_gts} GT/s`);
  if (v.width !== undefined) out.push(`x${v.width}`);
  if (v.bytes !== undefined) out.push(`${v.bytes} B`);
  if (p.kind === "DLLP") out.push(p.status === "ok" ? "CRC OK" : "CRC BAD");
  return out.length ? out.join(" · ") : e.summary;
}

// 端到端时序表：逐步列出时刻、相邻步间隔、所在层/方向与关键属性
function renderFlowTable() {
  if (!activeFlow || activeFlow.length < 2) return "";
  const first = activeFlow[0];
  const last = activeFlow[activeFlow.length - 1];
  const span = (last.raw_t_ns - first.raw_t_ns).toFixed(2);
  const name = first.type.replace(/ DLLP$/, "");
  const rows = activeFlow.map((e, i) => {
    const dt = i === 0 ? "—" : `+${(e.raw_t_ns - activeFlow[i - 1].raw_t_ns).toFixed(2)}`;
    const dir = e.dir === "TX" || e.dir === "→" ? "▸TX"
      : e.dir === "RX" || e.dir === "←" ? "◂RX" : "—";
    const cur = selected && e.id === selected.id ? " class=\"cur\"" : "";
    return `<tr${cur} data-id="${e.id}"><td>${i + 1}</td><td>${e.raw_t_ns.toFixed(2)}</td>` +
      `<td>${dt}</td><td>${escapeHtml(e.row)} ${dir}</td><td>${escapeHtml(e.type)}</td>` +
      `<td>${escapeHtml(stepAttrs(e))}</td></tr>`;
  }).join("");
  return `<div class="flow-card"><div class="flow-h">端到端路径 · ${escapeHtml(name)} · ${activeFlow.length} 步 · 首末间隔 ${span} ns</div>` +
    `<table class="flow-table"><thead><tr><th>#</th><th>t (ns)</th><th>Δt</th><th>位置</th><th>事件</th><th>关键属性</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`;
}

function showFlow(ev) {
  clearFlow();
  const group = flowGroup(ev);
  if (!group.length) return;
  // 双击的方块同步成为当前选中事件，保证标题与表格一致
  if (!selected || selected.id !== ev.id) selectEvent(ev, false);
  activeFlow = group;
  if (selected) renderDetailTab();
  const grid = document.querySelector(".tl-grid");
  if (!grid) return;
  const nodes = group
    .map((e) => document.querySelector(`.ev[data-id="${e.id}"]`))
    .filter(Boolean);
  nodes.forEach((n) => n.classList.add("hl"));
  if (nodes.length < 2) return;

  const NS = "http://www.w3.org/2000/svg";
  const gb = grid.getBoundingClientRect();
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "flow-svg");
  svg.setAttribute("width", grid.offsetWidth);
  svg.setAttribute("height", grid.offsetHeight);
  const defs = document.createElementNS(NS, "defs");
  defs.innerHTML = `<marker id="flowArrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#ffd166"/></marker>`;
  svg.appendChild(defs);

  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i].getBoundingClientRect();
    const b = nodes[i + 1].getBoundingClientRect();
    const x1 = a.left - gb.left + a.width / 2;
    const y1 = a.top - gb.top + a.height / 2;
    const x2 = b.left - gb.left + b.width / 2;
    const y2 = b.top - gb.top + b.height / 2;
    const mx = (x1 + x2) / 2;
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", `M${x1.toFixed(1)},${y1.toFixed(1)} C${mx.toFixed(1)},${y1.toFixed(1)} ${mx.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`);
    p.setAttribute("class", "flow-arrow");
    p.setAttribute("marker-end", "url(#flowArrow)");
    svg.appendChild(p);
  }
  grid.appendChild(svg);
  flowSvg = svg;
}

function renderTimeline() {
  const lanes = timelineLanes();
  const dur = Math.max(trace.duration_ns, 1);
  const viewW = Math.max(($("#timeline").clientWidth || 900) - 30 - LABEL_W, 620);
  const total = Math.round(viewW * timelineZoom);

  const ticks = 10;
  const axis = Array.from({ length: ticks + 1 }, (_, i) => {
    const t = (dur * i) / ticks;
    const left = (total * i) / ticks;
    return `<span class="tl-tick" style="left:${left.toFixed(1)}px">${t.toFixed(t >= 100 ? 0 : 1)} ns</span>`;
  }).join("");

  const body = lanes.map((lane) => {
    const evs = trace.events.filter((e) => e.row === lane.row &&
      (lane.dir ? e.dir === lane.dir : !["TX", "RX", "→", "←"].includes(e.dir)));
    let blocks = "";
    let height = 26;
    const dirName = lane.dir === "→" ? "（RC → EP）" : lane.dir === "←" ? "（EP → RC）" : "";
    const title = `${lane.row}${lane.dir ? " " + lane.dir : ""}${dirName}`;

    if (lane.row === "STATE") {
      // 状态是持续区间：块延伸到下一个状态，宽度足够时显示全名
      blocks = evs.map((e, i) => {
        const left = (e.raw_t_ns / dur) * total;
        const end = i + 1 < evs.length ? evs[i + 1].raw_t_ns : dur;
        const w = Math.max(4, (end / dur) * total - left - 1);
        const full = fullState(e);
        const fits = Math.floor((w - 6) / (CHAR_W * 0.85));
        const showFull = fits >= full.length;
        const label = showFull ? full : (w > 3 ? shortState(e) : "");
        return `<div class="ev ${cls(e)} span" data-id="${e.id}"
          style="left:${left.toFixed(1)}px;top:3px;height:20px;width:${w.toFixed(1)}px;font-size:${showFull ? 9 : 7.5}px"
          title="#${e.id}  ${escapeAttr(e.summary)}">${escapeHtml(label)}</div>`;
      }).join("");
    } else {
      // 密集事件自动分行，避免块互相压盖
      const lanes2 = [];
      const placed = evs.map((e, i) => {
        const x = (e.raw_t_ns / dur) * total;
        const nextX = i + 1 < evs.length ? (evs[i + 1].raw_t_ns / dur) * total : total;
        // 留 3px 间隙，保证下一个事件能落在同一子行，避免每条泳道都被迫换行
        const w = Math.max(MIN_BLOCK, Math.min(nextX - x - 3, 260));
        let li = lanes2.findIndex((free) => x >= free);
        if (li < 0) {
          lanes2.push(0);
          li = lanes2.length - 1;
        }
        lanes2[li] = x + w + 2;
        return { e, x, w, li };
      });
      height = Math.max(1, lanes2.length) * LANE_H + 6;
      blocks = placed.map(({ e, x, w, li }) => {
        // 按可用像素宽度截取类型名，至少保证 "TS1" 这类 3 字符可读
        const maxChars = Math.max(2, Math.floor((w - 6) / CHAR_W));
        const label = shortType(e.type).slice(0, maxChars);
        const dirTxt = e.dir === "TX" || e.dir === "→" ? "▸TX"
          : e.dir === "RX" || e.dir === "←" ? "◂RX" : "";
        const isRx = e.dir === "RX" || e.dir === "←";
        return `<div class="ev ${cls(e)} ${isRx ? "rx" : "tx"}" data-id="${e.id}"
          style="left:${x.toFixed(1)}px;top:${li * LANE_H + 3}px;height:${LANE_H - 4}px;line-height:${LANE_H - 4}px;width:${w.toFixed(1)}px"
          title="#${e.id} ${dirTxt ? "[" + dirTxt + "] " : ""}${escapeAttr(e.summary)}  · 双击查看端到端路径">${escapeHtml(label)}</div>`;
      }).join("");
    }
    return `<div class="tl-row" style="height:${height}px">` +
      `<div class="tl-rowlabel" title="${escapeAttr(title)}">` +
      `<span>${escapeHtml(lane.label)}</span>${dirTag(lane.dir)}</div>` +
      `<div class="tl-track" style="width:${total}px;height:${height}px">${blocks}</div></div>`;
  }).join("");

  const phaseRow = showPhases ? renderPhaseRow(dur, total) : "";
  $("#timeline").innerHTML = `<div class="tl-grid" style="width:${total + LABEL_W}px">` +
    `${phaseRow}<div class="tl-axis" style="width:${total}px;margin-left:${LABEL_W}px">${axis}</div>${body}</div>`;
  document.querySelectorAll(".ev").forEach((el) => {
    el.onclick = () => {
      const ev = trace.events.find((e) => e.id === Number(el.dataset.id));
      if (ev) selectEvent(ev, true);
    };
    el.ondblclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ev = trace.events.find((x) => x.id === Number(el.dataset.id));
      if (ev) showFlow(ev);
    };
  });
  if (selected) markSelected();
}

function cls(e) {
  const layer = e.layer.toLowerCase();
  return `${layer} ${e.status}`;
}

function niceType(t) {
  return (t || "").replace(/ .*$/, "").slice(0, 14);
}

// 时间块很窄时用行业常用缩写，保证 4 个字符内可辨识
function shortType(t) {
  const s = t || "";
  const fixed = { "TLP+Seq+LCRC": "TLP", "Ack DLLP": "Ack", "Nak DLLP": "Nak" };
  if (fixed[s]) return fixed[s];
  const u = /^UpdateFC-(\w+)$/.exec(s);
  if (u) return "UFC" + u[1].slice(0, 1).toUpperCase();
  const i = /^InitFC([12])-(\w+)$/.exec(s);
  if (i) return "IF" + i[1] + i[2].slice(0, 1).toUpperCase();
  return s.replace(/ .*$/, "");
}

const STATE_ABBR = {
  "Detect.Quiet": "D.Quiet",
  "Detect.Active": "D.Active",
  "Polling.Active": "Poll.Active",
  "Polling.Configuration": "Poll.Cfg",
  "Configuration.Linkwidth.Start": "Cfg.LW.S",
  "Configuration.Linkwidth.Accept": "Cfg.LW.A",
  "Configuration.LaneNum.Wait": "Cfg.LN.W",
  "Configuration.LaneNum.Accept": "Cfg.LN.A",
  "Configuration.Complete": "Cfg.Comp",
  "Configuration.Idle": "Cfg.Idle",
  "Recovery.RcvrLock": "Rec.Lock",
  "Recovery.Equalization": "Rec.EQ",
  "Recovery.Speed": "Rec.Spd",
  "Recovery.RcvrCfg": "Rec.Cfg",
  "Recovery.Idle": "Rec.Idle",
};

function fullState(e) {
  const m = /进入\s*([A-Za-z0-9._]+)/.exec(e.summary || "");
  return m ? m[1] : niceType(e.type);
}

function shortState(e) {
  const name = fullState(e);
  return STATE_ABBR[name] || name;
}

function markSelected() {
  document.querySelectorAll(".ev").forEach((el) => {
    el.classList.toggle("selected", Number(el.dataset.id) === selected.id);
  });
}

function selectEvent(ev, scroll) {
  selected = ev;
  markSelected();
  $("#detailTitle").textContent = `#${ev.id} · ${ev.type}`;
  renderDetailTab();
}

function renderDetailTab() {
  if (!selected) return;
  const p = selected.packet;
  if (!p) {
    const notes = (selected.notes || []).map((c) =>
      `<li class="${c.level}"><b>${c.code}</b> ${escapeHtml(c.text)}</li>`).join("");
    $("#detail").innerHTML = renderFlowTable() + (notes
      ? `<div class="checks">${notes}</div>`
      : `<p class="empty">该事件没有结构化报文（${selected.summary}）。</p>`);
    bindFlowRows();
    return;
  }
  let body;
  if (activeTab === "tree") body = renderTree(p);
  else if (activeTab === "layers") body = renderLayers(selected);
  else if (activeTab === "bits") body = renderBits(p);
  else if (activeTab === "hex") body = renderHex(p);
  else if (activeTab === "flit") body = renderFlit(p);
  else body = renderChecks(p, selected);
  $("#detail").innerHTML = renderFlowTable() + renderExplain(p) + body;
  bindFieldCells($("#detail"), p);
  bindFlowRows();
}

// 点击端到端时序表的某一行 → 跳转并选中该步事件（高亮与箭头保持不变）
function bindFlowRows() {
  document.querySelectorAll(".flow-table tr[data-id]").forEach((tr) => {
    tr.onclick = () => {
      const ev = trace.events.find((e) => e.id === Number(tr.dataset.id));
      if (ev) selectEvent(ev, true);
    };
  });
}

/* 报文协议语义：本次事件的具体含义（默认展开）+ 通用协议语义（折叠） */
function explainBlock(e, cls) {
  if (!e) return "";
  const kv = (e.kv || []).map((r) =>
    `<dt>${escapeHtml(r[0])}</dt><dd>${escapeHtml(r[1])}</dd>`).join("");
  const bullets = (e.bullets || []).map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  const path = (e.path || []).map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  return `<div class="${cls}">
    ${e.title ? `<div class="explain-h">${escapeHtml(e.title)}</div>` : ""}
    ${kv ? `<dl class="explain-kv">${kv}</dl>` : ""}
    ${bullets ? `<div class="explain-sub">物理含义</div><ul>${bullets}</ul>` : ""}
    ${path ? `<div class="explain-sub">触发路径</div><ol>${path}</ol>` : ""}
  </div>`;
}

function renderExplain(p) {
  const e = p && p.explain;
  if (!e) return "";
  const ev = e.event || (e.bullets || e.path ? e : null);
  const gen = e.generic;
  let html = "";
  if (ev) html += explainBlock(ev, "explain-event");
  if (gen) {
    html += `<details class="explain-fold">
      <summary>通用协议语义：物理含义 / 触发路径</summary>
      ${explainBlock(gen, "explain-generic")}
    </details>`;
  }
  return html ? `<div class="explain">${html}</div>` : "";
}

/* 字段定义弹窗：展示协议中的位域描述与取值编码 */
function codeLabel(c, f) {
  if (typeof c.value !== "number") return String(c.value);
  if (f.kind === "bin" || f.width === 1) return c.value.toString(2).padStart(f.width || 1, "0") + "b";
  if (f.kind === "hex") return "0x" + c.value.toString(16).toUpperCase();
  return String(c.value);
}

function codeTable(f) {
  const codes = f.codes || [];
  if (!codes.length) return "";
  const rows = codes.map((c) => {
    const cur = String(c.value) === String(f.value);
    return `<div class="coderow${cur ? " cur" : ""}">` +
      `<span class="cv">${escapeHtml(codeLabel(c, f))}</span>` +
      `<span class="ct">${escapeHtml(c.text)}</span></div>`;
  }).join("");
  return `<div class="codes">
    <b>编码定义</b>
    <div class="codetable">
      <div class="coderow head"><span class="cv">编码</span><span class="ct">含义</span></div>
      ${rows}
    </div>
  </div>`;
}

function showFieldInfo(f) {
  if (!f) return;
  const val = f.display !== undefined ? f.display : String(f.value);
  let raw = "";
  if (typeof f.value === "number") {
    raw = `0x${f.value.toString(16).toUpperCase()} · 0b${f.value.toString(2).padStart(f.width || 1, "0")}`;
  }
  $("#fieldTitle").textContent = f.name;
  $("#fieldBody").innerHTML = `
    <dl class="kv fieldkv">
      <dt>位域</dt><dd>${escapeHtml(bitRange(f))}</dd>
      <dt>宽度</dt><dd>${f.width || 1} bit</dd>
      <dt>当前值</dt><dd>${escapeHtml(val)}</dd>
      ${raw ? `<dt>原始值</dt><dd>${raw}</dd>` : ""}
      ${f.group ? `<dt>分组</dt><dd>${escapeHtml(f.group)}</dd>` : ""}
    </dl>
    <div class="fielddesc">
      <b>协议定义</b>
      <p>${escapeHtml(f.desc || "该字段在协议中无额外说明。")}</p>
    </div>
    ${codeTable(f)}`;
  $("#fieldModal").classList.remove("hidden");
}

function bindFieldCells(container, p) {
  if (!container || !p) return;
  container.querySelectorAll("[data-fi]").forEach((el) => {
    el.onclick = () => showFieldInfo((p.fields || [])[Number(el.dataset.fi)]);
  });
}

const VAL_LABEL = {
  rate_gts: "速率（GT/s）", width: "Lane 数", bytes: "字节数",
  seq: "Seq", kind: "类型", lcrc_ok: "LCRC 校验", corrupt: "注入错误",
};

/* 无逐位字段的报文（PHY 编码/解码、有序集等）用键值表展示参数 */
function renderValues(values) {
  return Object.entries(values || {}).map(([k, v]) =>
    `<div class="frow"><div class="fname">${escapeHtml(VAL_LABEL[k] || k)}</div>
      <div class="fval">${escapeHtml(String(v))}</div><div class="fdesc"></div></div>`).join("");
}

function renderTree(p) {
  const head = `<div class="frow group"><div>字段</div><div>值</div><div>说明</div></div>`;
  let lastGroup = "";
  const rows = (p.fields || []).map((f) => {
    let g = "";
    if (f.group && f.group !== lastGroup) {
      lastGroup = f.group;
      g = `<div class="group">${f.group}</div>`;
    }
    const disp = f.display !== undefined ? f.display : String(f.value);
    return `${g}<div class="frow"><div class="fname">${f.name}</div>
      <div class="fval">${escapeHtml(disp)}</div>
      <div class="fdesc">${escapeHtml(f.desc || "")}</div></div>`;
  }).join("");
  const summary = `<div class="group">报文摘要</div>
    <div class="frow"><div class="fname">${p.type || ""}</div>
    <div class="fval">${escapeHtml(p.summary || "")}</div>
    <div class="fdesc">${escapeHtml(p.name || "")}</div></div>`;
  const body = rows ||
    (p.values ? `<div class="group">参数</div>${renderValues(p.values)}`
              : '<p class="empty">无字段</p>');
  return `<div class="tree">${head}${summary}${body}</div>`;
}

/* ---------------- 分层视图 ---------------- */

const LAYER_NAME = { Transaction: "L3 事务层", "Data Link": "L2 数据链路层", Physical: "L1 物理层" };
const LAYER_KEY = { Transaction: "l3", "Data Link": "l2", Physical: "l1" };

function renderLayers(ev) {
  const stages = ev.stages;
  if (!stages || !stages.length) {
    return `<p class="empty">该事件没有分层处理记录。请选择时序图 TLP 泳道（RC.TLP / EP.TLP）中的事件。</p>`;
  }
  const legend = `<div class="ownerlegend">
      <span><i class="l3"></i>L3 事务层：TLP Header / Payload</span>
      <span><i class="l2"></i>L2 数据链路层：Seq / LCRC（FLIT 下为 DLP / FLIT CRC）</span>
      <span><i class="l1"></i>L1 物理层：Sync Header / 扰码 / FEC</span>
    </div>`;
  const cards = stages.map((s) => {
    const adds = (s.add || []).map((t) => `<span class="chip add">+ ${escapeHtml(t)}</span>`).join("");
    const rems = (s.remove || []).map((t) => `<span class="chip rem">− ${escapeHtml(t)}</span>`).join("");
    return `<div class="stage">
      <div class="stage-head">
        <span class="badge ${LAYER_KEY[s.layer] || ""}">${LAYER_KEY[s.layer] || "?"}</span>
        <span class="stage-layer">${LAYER_NAME[s.layer] || s.layer}</span>
        <span class="stage-side">${s.side} · ${s.dir}</span>
        <b>${escapeHtml(s.title)}</b>
      </div>
      <div class="stage-detail">${escapeHtml(s.detail)}</div>
      ${ownerBar(s.regions || [])}
      <div class="stage-chips">${adds}${rems}</div>
      <div class="stage-bytes">${escapeHtml(s.bytes || "")}</div>
    </div>`;
  }).join("");
  return legend + `<div class="stages">${cards}</div>`;
}

function ownerBar(regions) {
  if (!regions.length) return "";
  const total = Math.max(...regions.map((r) => r.start + r.len), 1);
  const segs = regions.map((r) => {
    const left = (100 * r.start) / total;
    const w = (100 * r.len) / total;
    const label = w > 9 ? escapeHtml(r.name) : "";
    return `<div class="seg ${r.owner}" style="left:${left}%;width:${w}%"
      title="${escapeAttr(r.name)} · ${r.len} B · 归 ${r.owner}">${label}</div>`;
  }).join("");
  return `<div class="ownerbar">${segs}</div>`;
}

// 位域图：仿 PCIe databook 布局——每行 4 字节（+0..+3），每字节上方标 bit 7..0
function shortFieldValue(f, span) {
  // 宽块用完整 display，窄块用紧凑值
  if (span >= 6 && f.display) return f.display;
  const v = f.value;
  if (typeof v === "number") {
    if (f.kind === "hex") return "0x" + v.toString(16).toUpperCase();
    if (f.kind === "bin") return v.toString(2).padStart(f.width || 1, "0") + "b";
    if (f.kind === "bool") return v ? "1" : "0";
    return String(v);
  }
  if (f.display) return f.display;
  return String(v);
}

function renderBits(p) {
  const fields = p.fields || [];
  const totalBits = p.kind === "FLIT" ? 2048 : (p.total_len || 4) * 8;
  const maxBit = Math.max(totalBits, ...fields.map((f) => (f.end || 0) + 1));
  const nDw = Math.ceil(maxBit / 32);
  const bytes = hexBytes(p.raw || "");

  const bitHdr = Array.from({ length: 32 }, (_, i) => `<span>${7 - (i % 8)}</span>`).join("");
  const hlenBits = (p.header_len || 0) * 8;
  let rows = "";
  let skipped = 0;
  let payloadDw = 0;

  for (let dw = 0; dw < nDw; dw++) {
    const lo = dw * 32;
    const segs = [];
    fields.forEach((f, idx) => {
      const s = f.start || 0;
      const e = f.end !== undefined ? f.end : s + (f.width || 1) - 1;
      const is = Math.max(s, lo);
      const ie = Math.min(e, lo + 31);
      if (is <= ie) segs.push({ f, idx, is, ie });
    });
    if (!segs.length) {
      // Payload 行不展开字段，统一折叠成一行提示
      if (lo >= hlenBits) { payloadDw++; continue; }
      if (dw > 8) { skipped++; continue; }
    }
    if (skipped) {
      rows += `<div class="tlp-skip">… 跳过 ${skipped} 个无字段的 DW</div>`;
      skipped = 0;
    }
    const hex = bytes.slice(dw * 4, dw * 4 + 4)
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
    const blocks = segs.map(({ f, idx, is, ie }) => {
      const col = is - lo + 1;
      const span = ie - is + 1;
      const full = f.display !== undefined ? f.display : String(f.value);
      const tip = `${f.name} ${bitRange(f)} = ${full}${f.desc ? " — " + f.desc : ""}`;
      const showName = span >= 2 && f.name.length <= 18;
      const name = f.name.length > 18 ? f.name.slice(0, 16) + "…" : f.name;
      const val = shortFieldValue(f, span);
      return `<div class="tlp-cell" data-fi="${idx}" data-span="${span}" ` +
        `style="grid-column:${col} / span ${span}" title="${escapeAttr(tip)}">` +
        (showName ? `<b>${escapeHtml(name)}</b>` : "") +
        `<i>${escapeHtml(val)}</i></div>`;
    }).join("");
    rows += `<div class="tlp-rowlabel" title="DW${dw} = ${hex}"><b>Byte ${dw * 4}</b><span>${hex}</span></div>` +
      `<div class="tlp-lane">${blocks}</div>`;
  }

  if (payloadDw) {
    rows += `<div class="tlp-skip">… Payload ${payloadDw} DW（${payloadDw * 4} B）未展开，内容见“原始字节”</div>`;
  }

  return `<div class="hint">点击任意字段块查看协议定义</div>` +
    `<div class="tlp-grid">
    <div></div>
    <div class="tlp-bytehdr"><span>+0</span><span>+1</span><span>+2</span><span>+3</span></div>
    <div></div>
    <div class="tlp-bithdr">${bitHdr}</div>
    ${rows}
  </div>`;
}

function renderHex(p) {
  const text = p.raw || "";
  const bytes = text.trim() ? text.trim().split(/\s+/).map((h) => parseInt(h, 16)) : [];
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const hex = chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`<span class="off">${i.toString(16).padStart(4, "0")}</span>  ${hex} <span class="ascii">|${ascii}|</span>`);
  }
  const regions = p.regions ? `<div class="flitlegend" style="margin-bottom:8px">
    <span>TLP: ${p.regions.tlp.slice(0, 24)}…</span></div>` : "";
  return `<div class="hexdump">${lines.join("\n")}</div>${regions}`;
}

function renderFlit(p) {
  if (!p.regions) {
    return `<p class="empty">该事件不是 256B FLIT。切换到 Gen6 场景（gen6_burst / gen6_fec_error）并选中 DLL 层事件可查看 FLIT 布局。</p>`;
  }
  const bytes = (p.raw || "").trim().split(/\s+/).length ? (p.raw || "").trim().split(/\s+/).map((h) => parseInt(h, 16)) : [];
  const cells = bytes.map((b, i) => {
    let kind = "tlp";
    if (i >= 236 && i < 242) kind = "dlp";
    else if (i >= 242 && i < 250) kind = "crc";
    else if (i >= 250) kind = "fec";
    return `<div class="cell ${kind}" title="byte ${i} = 0x${b.toString(16).padStart(2, "0")}">${b.toString(16).padStart(2, "0")}</div>`;
  }).join("");
  const tlps = (p.tlps || []).map((t) => `<span class="chip"><i style="background:var(--tlp)"></i>@${t.offset_in_flit}B ${t.type} · ${t.total_len}B</span>`).join(" ");
  return `<div class="flitview">
    <div class="flitlegend">
      <span><i style="display:inline-block;width:9px;height:9px;background:rgba(77,163,255,.5);border-radius:2px"></i> TLP 0–235</span>
      <span><i style="display:inline-block;width:9px;height:9px;background:rgba(169,123,255,.6);border-radius:2px"></i> DLP 236–241</span>
      <span><i style="display:inline-block;width:9px;height:9px;background:rgba(47,208,180,.6);border-radius:2px"></i> CRC 242–249</span>
      <span><i style="display:inline-block;width:9px;height:9px;background:rgba(240,180,41,.6);border-radius:2px"></i> FEC 250–255</span>
    </div>
    <div class="cells">${cells}</div>
    <div class="legendline">${tlps}</div>
  </div>`;
}

function renderChecks(p, ev) {
  const all = [...(p.checks || []), ...(ev.notes || [])];
  if (!all.length) return `<p class="empty">该报文没有检查项（或全部由引擎层检查）。</p>`;
  return `<div class="checks">${all.map((c) =>
    `<li class="${c.level}"><b>${c.code}</b> ${escapeHtml(c.text)}</li>`).join("")}</div>`;
}

/* ---------------- 解码器 ---------------- */

async function decodePackets() {
  const data = $("#decodeInput").value;
  const format = $("#decodeFormat").value;
  $("#decodeResult").innerHTML = '<p class="empty">静态部署版不含解码后端；本地运行 <code>python3 -m pciewatch serve</code> 后可使用。</p>';
  return;
  if (out.error) {
    $("#decodeResult").innerHTML = `<p class="empty">${escapeHtml(out.error)}</p>`;
    return;
  }
  decodedPackets = out.packets || [];
  $("#decodeResult").innerHTML = decodedPackets.map((p, i) =>
    `<div class="dpkt ${p.status}" data-i="${i}"><div class="t">#${i} ${p.type} <span class="s">· ${p.kind}</span></div>
     <div class="s">${escapeHtml(p.summary || "")}</div></div>`).join("");
  document.querySelectorAll(".dpkt").forEach((el) => {
    el.onclick = () => {
      const p = decodedPackets[Number(el.dataset.i)];
      selected = { id: "decode-" + el.dataset.i, type: p.type, summary: p.summary, packet: p, status: p.status, layer: p.layer, notes: [] };
      $("#decodeModal").classList.add("hidden");
      $("#detailTitle").textContent = `解码 · ${p.type}`;
      activeTab = "tree";
      document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === "tree"));
      renderDetailTab();
    };
  });
}

function loadDecodeFile(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $("#decodeInput").value = reader.result;
    const name = file.name.toLowerCase();
    $("#decodeFormat").value = name.endsWith(".csv") ? "csv" : name.endsWith(".json") ? "json" : "hex";
  };
  reader.readAsText(file);
}

/* ---------------- 传输模型：AP → TL → DL → PHY → Wire → 对端 ---------------- */

const MODEL_MODULES = [
  ["AP", "AP 应用层", "请求 / 完成回调"],
  ["TL", "TL 事务层", "TLP 组装 / 解析"],
  ["DL", "DL 数据链路层", "Seq / LCRC · 重放"],
  ["MAC", "PHY · MAC", "成帧 · 扰码 · 同步头"],
  ["PCS", "PHY · PCS (UPSC)", "8b/10b · 128b/130b · PAM4/FEC"],
  ["PMA", "PHY · PMA/PMD", "串行化 · 驱动 · CDR · 均衡"],
];
const MODULE_CLASS = { AP: "l3", TL: "l3", DL: "l2", MAC: "l1", PCS: "l1", PMA: "l1", WIRE: "w" };

let modelStages = [];
let modelEvent = null;
let modelTxn = null;       // Non-Posted 完整事务：{req, cpl}
let modelStep = 0;
let modelTimer = null;
let modelTrace = null;     // 当前模型使用的 trace（主场景或内置示例）
let sampleTrace = null;    // tlp_samples 场景缓存

const MODEL_SAMPLES = [
  ["mrd3", "MemRd · 32-bit 地址（3DW Header）"],
  ["mrd4", "MemRd · 64-bit 地址（4DW Header）"],
  ["mwr3", "MemWr · 32-bit 地址（3DW Header）"],
  ["mwr4", "MemWr · 64-bit 地址（4DW Header）"],
  ["msg", "Msg · 4DW Header（无数据）"],
  ["msgd", "MsgD · 4DW Header（带数据）"],
];

function openModel() {
  if (!trace) return;
  modelTrace = trace;
  $("#modelModal").classList.remove("hidden");
  fillModelPkts(selected ? selected.id : null);
  const v = $("#modelPkt").value || "";
  if (v.startsWith("s:")) onModelPktChange();
  else setModelEvent(pickEvent(trace, v));
}

function fillModelPkts(preselectId) {
  const tlps = modelTrace.events.filter((e) => e.pipeline && e.pipeline.length);
  const opts = tlps.map((e) =>
    `<option value="e${e.id}">#${e.id} ${e.type} · ${escapeHtml(e.summary)}</option>`).join("");
  // Non-Posted：请求 + 完成整单播放
  const txns = modelTrace.events.filter((e) => e.txn && e.txn.role === "req" && e.pipeline);
  const txnOpts = txns.map((e) => {
    const cpl = modelTrace.events.find((x) => x.id === e.txn.peer);
    const steps = e.pipeline.length + ((cpl && cpl.pipeline) ? cpl.pipeline.length : 0);
    return `<option value="t:${e.id}:${e.txn.peer}">#${e.id} ${e.type} ⇄ ` +
      `#${e.txn.peer} ${cpl ? cpl.type : "Cpl"} · 完整事务（${steps} 步）</option>`;
  }).join("");
  const samples = MODEL_SAMPLES.map(([k, label]) =>
    `<option value="s:${k}">${label}</option>`).join("");
  $("#modelPkt").innerHTML =
    `<optgroup label="当前 trace">${opts}</optgroup>` +
    (txnOpts ? `<optgroup label="完整事务（Req + Cpl）">${txnOpts}</optgroup>` : "") +
    `<optgroup label="内置示例">${samples}</optgroup>`;
  if (preselectId != null && tlps.some((e) => e.id === preselectId)) {
    $("#modelPkt").value = "e" + preselectId;
  }
}

async function onModelPktChange() {
  const v = $("#modelPkt").value || "";
  if (v.startsWith("t:")) {
    const [rid, cid] = v.slice(2).split(":").map(Number);
    modelTrace = trace;
    const req = trace.events.find((e) => e.id === rid && e.pipeline);
    const cpl = trace.events.find((e) => e.id === cid && e.pipeline);
    if (req && cpl) setModelTxn(req, cpl);
    return;
  }
  if (v.startsWith("s:")) {
    const st = await ensureSamples();
    const ev = pickSample(st, v.slice(2));
    modelTrace = st;
    setModelEvent(ev);
    return;
  }
  modelTrace = trace;
  setModelEvent(pickEvent(trace, v));
}

function setModelTxn(req, cpl) {
  stopAuto();
  modelTxn = { req, cpl };
  modelEvent = req;
  modelStages = [
    ...(req.pipeline || []).map((s) => ({ ...s, phase: "请求" })),
    ...(cpl.pipeline || []).map((s) => ({ ...s, phase: "完成" })),
  ];
  modelStep = 0;
  renderModel();
  renderStep();
}

function pickEvent(tr, value) {
  const id = Number(String(value).replace(/^e/, ""));
  return tr.events.find((e) => e.id === id && e.pipeline) || null;
}

function pickSample(tr, key) {
  const tlps = tr.events.filter((e) => e.pipeline && e.pipeline.length);
  const byHeader = (type, hlen) =>
    tlps.find((e) => e.type === type && e.packet && e.packet.header_len === hlen);
  const map = {
    mrd3: () => byHeader("MRd", 12),
    mrd4: () => byHeader("MRd", 16),
    mwr3: () => byHeader("MWr", 12),
    mwr4: () => byHeader("MWr", 16),
    msg: () => tlps.find((e) => e.type === "Msg"),
    msgd: () => tlps.find((e) => e.type === "MsgD"),
  };
  return (map[key] || (() => tlps[0]))() || null;
}

async function ensureSamples() {
  if (sampleTrace) return sampleTrace;
  try {
    const res = await fetch(API + "/tlp_samples.json");
    sampleTrace = await res.json();
  } catch (e) {
    sampleTrace = { events: [] };
  }
  return sampleTrace;
}

function setModelEvent(ev) {
  stopAuto();
  modelTxn = null;
  modelEvent = ev || null;
  modelStages = (ev && ev.pipeline) || [];
  modelStep = 0;
  renderModel();
  $("#stepLayout").innerHTML = renderTlpLayout(modelEvent);
  bindFieldCells($("#stepLayout"), modelEvent && modelEvent.packet);
  renderStep();
}

/* 布局展示：TLP 按 DW 逐行；DLLP 显示 4 B 内容 + 2 B CRC */
function hexBytes(raw) {
  return (raw || "").trim().split(/\s+/).map((h) => parseInt(h, 16)).filter((n) => !Number.isNaN(n));
}

function dwLine(label, chunk, desc, cls) {
  const hex = chunk.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  return `<div class="dwline ${cls}"><span class="dw">${label}</span>` +
    `<span class="hex">${hex}</span><span class="fd">${escapeHtml(desc || "")}</span></div>`;
}

// 位范围按 databook 口径：字节偏移 + 字节内 bit7..0（Fmt = Byte 0 [7:5]）
function bitRange(f) {
  const s = f.start || 0;
  const e = f.end !== undefined ? f.end : s + (f.width || 1) - 1;
  const b0 = Math.floor(s / 8);
  const b1 = Math.floor(e / 8);
  if (b0 !== b1) return `Byte ${b0}–${b1}`;
  const hi = 7 - (s % 8);
  const lo = 7 - (e % 8);
  return hi === lo ? `Byte ${b0} [${hi}]` : `Byte ${b0} [${hi}:${lo}]`;
}

// 每个字段一行：名称、bit 范围、当前值（点击可查看协议定义）
function fieldRows(list, all) {
  return [...list]
    .map((f) => ({ f, i: all.indexOf(f) }))
    .sort((a, b) => (a.f.start || 0) - (b.f.start || 0))
    .map(({ f, i }) => {
      const range = bitRange(f);
      const val = f.display !== undefined ? f.display : String(f.value);
      return `<div class="fieldline" data-fi="${i}" title="${escapeAttr(f.name + " " + range + " = " + val)}">` +
        `<span class="fname">${escapeHtml(f.name)}</span>` +
        `<span class="range">${range}</span>` +
        `<span class="fval2">${escapeHtml(val)}</span></div>`;
    }).join("");
}

function renderTlpLayout(ev) {
  const p = ev && ev.packet;
  if (!p || !p.raw) return `<p class="empty">该事件没有字节内容</p>`;
  const bytes = hexBytes(p.raw);
  if (!bytes.length) return `<p class="empty">该事件没有字节内容</p>`;
  if (p.kind === "DLLP") return renderDllpLayout(p, bytes);

  const hlen = Math.min(p.header_len || 12, bytes.length);
  const plen = Math.min(p.payload_len || 0, bytes.length - hlen);
  const row = (label, off, desc, cls) => dwLine(label, bytes.slice(off, off + 4), desc, cls);

  // 字段按起始 DW 分组，每个 DW 内逐字段展开
  const byDw = {};
  (p.fields || []).forEach((f) => {
    const dw = Math.floor((f.start || 0) / 32);
    (byDw[dw] = byDw[dw] || []).push(f);
  });

  const hdw = Math.ceil(hlen / 4);
  let html = `<div class="lph">TLP Header · ${hdw} DW / ${hlen} B</div>`;
  for (let i = 0; i < hdw; i++) {
    html += row("DW" + i, i * 4, "", "hdr");
    html += fieldRows(byDw[i] || [], p.fields || []);
  }

  if (plen > 0) {
    const pdw = Math.ceil(plen / 4);
    html += `<div class="lph">Payload · ${pdw} DW / ${plen} B</div>`;
    const LIMIT = 6;
    if (pdw <= LIMIT) {
      for (let i = 0; i < pdw; i++) html += row("DW" + i, hlen + i * 4, "", "pay");
    } else {
      for (let i = 0; i < LIMIT - 1; i++) html += row("DW" + i, hlen + i * 4, "", "pay");
      html += `<div class="dwmore">… 其余 ${pdw - LIMIT} DW 省略（共 ${plen} B）</div>`;
      html += row("DW" + (pdw - 1), hlen + (pdw - 1) * 4, "末 DW", "pay");
    }
  }
  return html;
}

function renderDllpLayout(p, bytes) {
  const content = bytes.slice(0, 4);
  const crc = bytes.slice(4);
  const dw0 = (p.fields || []).filter((f) => (f.start || 0) < 32);
  const crcFields = (p.fields || []).filter((f) => (f.start || 0) >= 32);
  let html = `<div class="lph">DLLP · ${bytes.length} B（内容 4 B + CRC 2 B）</div>`;
  html += dwLine("DW0", content, "", "hdr");
  html += fieldRows(dw0, p.fields || []);
  html += dwLine("CRC", crc, "", "pay");
  html += fieldRows(crcFields, p.fields || []);
  return html;
}

function renderModel() {
  const rows = MODEL_MODULES.length;
  let html = `<div class="model" style="grid-template-rows:auto repeat(${rows},auto)">`;
  html += `<div class="devhead" style="grid-column:1;grid-row:1">RC · Root Complex</div>`;
  html += `<div class="devhead" style="grid-column:3;grid-row:1">EP · Endpoint</div>`;
  MODEL_MODULES.forEach(([key, label, sub], i) => {
    ["RC", "EP"].forEach((side, ci) => {
      html += `<div class="blk" data-side="${side}" data-module="${key}"
        style="grid-column:${ci === 0 ? 1 : 3};grid-row:${i + 2}">
        <span class="m">${label}</span><span class="s">${sub}</span></div>`;
    });
  });
  html += `<div class="wire" style="grid-column:2;grid-row:${rows + 1}">
    <span class="war">⇄</span><span class="wlabel">Wire</span></div></div>`;
  $("#modelStack").innerHTML = html;
}

function markStage(st, cls) {
  const el = st.module === "WIRE"
    ? $(".wire")
    : document.querySelector(`.blk[data-side="${st.side}"][data-module="${st.module}"]`);
  if (el) el.classList.add(cls);
}

function renderStep() {
  const s = modelStages[modelStep];
  if (!s) return;
  document.querySelectorAll(".blk, .wire").forEach((el) => el.classList.remove("active", "done"));
  modelStages.forEach((st, i) => { if (i < modelStep) markStage(st, "done"); });
  markStage(s, "active");

  $("#stepBadge").textContent = s.module;
  $("#stepBadge").className = "badge " + (MODULE_CLASS[s.module] || "");
  $("#stepTitle").textContent = s.title;
  const phase = s.phase ? s.phase + " · " : "";
  $("#stepCount").textContent =
    `第 ${modelStep + 1} / ${modelStages.length} 步 · ${phase}${s.side || "链路"} · ${s.dir}`;
  $("#stepDetail").textContent = s.detail;
  $("#stepBar").innerHTML = ownerBar(s.regions || []);

  // 整单播放时，布局区跟随当前是请求还是完成
  const layoutEv = modelTxn
    ? (s.phase === "完成" ? modelTxn.cpl : modelTxn.req)
    : modelEvent;
  const layoutHead = modelTxn
    ? `<div class="lph" style="color:var(--accent)">${s.phase} TLP · #${layoutEv.id} ${escapeHtml(layoutEv.type)}</div>`
    : "";
  $("#stepLayout").innerHTML = layoutHead + renderTlpLayout(layoutEv);
  bindFieldCells($("#stepLayout"), layoutEv && layoutEv.packet);

  const adds = (s.add || []).map((t) => `<span class="chip add">+ ${escapeHtml(t)}</span>`).join("");
  const rems = (s.remove || []).map((t) => `<span class="chip rem">− ${escapeHtml(t)}</span>`).join("");
  $("#stepChips").innerHTML = adds + rems;
  $("#stepBytes").textContent = s.bytes ? "字节：" + s.bytes : "";

  $("#stepRange").max = Math.max(0, modelStages.length - 1);
  $("#stepRange").value = modelStep;
}

function setModelStep(n) {
  if (!modelStages.length) return;
  modelStep = Math.max(0, Math.min(n, modelStages.length - 1));
  renderStep();
}

function toggleAuto() {
  if (modelTimer) { stopAuto(); return; }
  if (!modelStages.length) return;
  if (modelStep >= modelStages.length - 1) setModelStep(0);
  $("#stepAuto").textContent = "暂停";
  modelTimer = setInterval(() => {
    if (modelStep >= modelStages.length - 1) { stopAuto(); return; }
    modelStep += 1;
    renderStep();
  }, 900);
}

function stopAuto() {
  if (modelTimer) clearInterval(modelTimer);
  modelTimer = null;
  $("#stepAuto").textContent = "自动播放";
}

/* ---------------- 工具 ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
