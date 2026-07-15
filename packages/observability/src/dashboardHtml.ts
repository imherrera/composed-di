/**
 * The dashboard page, served at "/". Self-contained: no build step, no CDN.
 *
 * Connects to "/events" (Server-Sent Events), receives a full snapshot, then
 * live span events. Renders the dependency graph as SVG (services laid out in
 * dependency ranks, dependencies on the left), a stat-tile row, a services
 * table, and an event log. Service state is shown as a status glyph + word,
 * never color alone.
 *
 * Visual language: warm paper surfaces, ink text, hairline rules. The orange
 * accent is reserved for live activity (call flashes, active edges,
 * selection); blue means initializing, green means ready. Display type is
 * Poppins and editorial notes are Lora — both resolve to local fonts only
 * (Arial / Georgia fallbacks), keeping the no-CDN contract.
 */
export function renderDashboardHtml(): string {
  return HTML
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>composed-di dashboard</title>
<style>
  :root {
    --page:            #faf9f5;
    --surface:         #fffefb;
    --ink:             #141413;
    --ink-secondary:   #5c5a53;
    --ink-muted:       #87857c;
    --ink-faint:       #b0aea5;
    --grid:            #e8e6dc;
    --edge:            #d6d3c8;
    --border:          rgba(20, 20, 19, 0.10);
    --accent:          #d97757;
    --good:            #788c5d;
    --busy:            #6a9bcc;
    --critical:        #b8442f;
    --shadow:          0 1px 2px rgba(20, 20, 19, 0.04);
    --overlay-shadow:  -14px 0 32px rgba(20, 20, 19, 0.14);
    --font-display:    "Poppins", "Avenir Next", "Segoe UI", Arial, sans-serif;
    --font-serif:      "Lora", Georgia, "Times New Roman", serif;
    --font-mono:       ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }
  /* Dark values apply via the system preference, or ?theme=dark|light. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --page:            #141413;
      --surface:         #1e1d1a;
      --ink:             #faf9f5;
      --ink-secondary:   #b0aea5;
      --ink-muted:       #8c8a80;
      --ink-faint:       #57554e;
      --grid:            #2c2b27;
      --edge:            #3a382f;
      --border:          rgba(250, 249, 245, 0.10);
      --accent:          #d97757;
      --good:            #8fa571;
      --busy:            #7ba3ce;
      --critical:        #dd5f4b;
      --shadow:          0 1px 2px rgba(0, 0, 0, 0.25);
      --overlay-shadow:  -14px 0 32px rgba(0, 0, 0, 0.45);
    }
  }
  :root[data-theme="dark"] {
    --page:            #141413;
    --surface:         #1e1d1a;
    --ink:             #faf9f5;
    --ink-secondary:   #b0aea5;
    --ink-muted:       #8c8a80;
    --ink-faint:       #57554e;
    --grid:            #2c2b27;
    --edge:            #3a382f;
    --border:          rgba(250, 249, 245, 0.10);
    --accent:          #d97757;
    --good:            #8fa571;
    --busy:            #7ba3ce;
    --critical:        #dd5f4b;
    --shadow:          0 1px 2px rgba(0, 0, 0, 0.25);
    --overlay-shadow:  -14px 0 32px rgba(0, 0, 0, 0.45);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    background-image: radial-gradient(1100px 380px at 75% -120px,
      color-mix(in srgb, var(--accent) 6%, transparent), transparent 70%);
    color: var(--ink);
    font: 14px/1.5 var(--font-display);
  }
  /* Brand rule: a single orange hairline crowning the page. */
  body::before {
    content: "";
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: var(--accent);
    z-index: 30;
  }
  ::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); }

  @keyframes rise {
    from { opacity: 0; transform: translateY(6px); }
  }
  header, .tiles, main > * { animation: rise 0.5s cubic-bezier(0.2, 0.7, 0.3, 1) backwards; }
  .tiles { animation-delay: 0.06s; }
  main > :nth-child(1) { animation-delay: 0.12s; }
  main > :nth-child(2) { animation-delay: 0.18s; }

  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 20px 24px 0;
  }
  header .mark { flex: none; }
  header h1 {
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0;
  }
  header .sub {
    color: var(--ink-muted);
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 13px;
  }
  #conn {
    margin-left: auto;
    font-size: 12px;
    color: var(--ink-secondary);
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 999px;
    padding: 3px 12px;
  }
  #conn.live::before {
    content: "\\25CF  ";
    color: var(--good);
    animation: breathe 2.4s ease-in-out infinite;
  }
  #conn.down::before { content: "\\25CF  "; color: var(--critical); }
  @keyframes breathe { 50% { opacity: 0.35; } }

  .tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 18px 24px 14px;
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow);
    padding: 12px 18px 14px;
    min-width: 148px;
  }
  .tile .label {
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 500;
    color: var(--ink-muted);
  }
  .tile .value {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .tile .value.bad { color: var(--critical); }
  .tile .value small { font-size: 13px; font-weight: 400; color: var(--ink-muted); }

  main {
    display: grid;
    grid-template-columns: 1fr 340px;
    gap: 14px;
    padding: 0 24px 24px;
    align-items: start;
  }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .panel h2 {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
    font-weight: 600;
    margin: 0;
    padding: 12px 16px;
    border-bottom: 1px solid var(--grid);
  }
  #graph-panel svg { display: block; width: 100%; }
  #graph-empty {
    padding: 40px 32px;
    color: var(--ink-muted);
    text-align: center;
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 14px;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 10px 16px;
    border-top: 1px solid var(--grid);
    font-size: 12px;
    color: var(--ink-secondary);
  }
  .legend .glyph { font-size: 11px; }
  .legend .hint {
    margin-left: auto;
    color: var(--ink-muted);
    font-family: var(--font-serif);
    font-style: italic;
  }

  /* Graph marks */
  .edge {
    fill: none;
    stroke: var(--edge);
    stroke-width: 1.5;
    transition: stroke 0.45s ease;
  }
  .edge.active { stroke: var(--accent); stroke-width: 2.5; transition: none; }
  .node rect {
    fill: var(--surface);
    stroke: var(--ink-faint);
    stroke-width: 1.5;
    rx: 8;
  }
  .node text { fill: var(--ink); font-size: 13px; font-weight: 600; }
  .node .status { fill: var(--ink-secondary); font-size: 11px; font-weight: 400; }
  .node .glyph { font-size: 10px; }
  .node.pending rect { stroke: var(--ink-faint); stroke-dasharray: 4 3; }
  .node.pending .glyph { fill: var(--ink-muted); }
  .node.initializing rect { stroke: var(--busy); animation: pulse 1s ease-in-out infinite; }
  .node.initializing .glyph { fill: var(--busy); }
  .node.ready rect { stroke: var(--good); }
  .node.ready .glyph { fill: var(--good); }
  .node.error rect { stroke: var(--critical); stroke-width: 2; }
  .node.error .glyph { fill: var(--critical); }
  .node.disposed rect { stroke: var(--grid); }
  .node.disposed .glyph { fill: var(--ink-muted); }
  .node.disposed text { fill: var(--ink-muted); }
  .node { cursor: pointer; }
  .node.flash rect {
    stroke: var(--accent);
    stroke-width: 2.5;
    fill: color-mix(in srgb, var(--accent) 7%, var(--surface));
  }
  .node.selected rect { stroke: var(--accent); stroke-width: 2.5; }
  .node:focus-visible { outline: none; }
  .node:focus-visible rect { stroke: var(--accent); }
  @keyframes pulse { 50% { stroke-opacity: 0.35; } }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 16px; border-top: 1px solid var(--grid); }
  thead th {
    border-top: none;
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
    font-weight: 600;
  }
  td.num, th.num { text-align: right; }
  td.num { font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
  td.err { color: var(--critical); font-weight: 600; }
  td .glyph { font-size: 10px; }

  /* Clickable service rows + per-method drill-down */
  tr.svc-row { cursor: pointer; }
  tr.svc-row:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
  tr.svc-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  tr.svc-row.selected { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  tr.svc-row .caret {
    display: inline-block;
    width: 14px;
    color: var(--ink-faint);
    font-size: 10px;
  }
  tr.method-detail > td { padding: 0; background: var(--page); }
  .methods table { font-size: 12px; }
  .methods thead th { font-size: 10px; }
  .methods th:first-child, .methods td:first-child { padding-left: 46px; }
  .methods .empty {
    padding: 8px 16px 10px 46px;
    color: var(--ink-muted);
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 12px;
  }

  /* Event log (shared row styles with the inspector's call history) */
  #log, .insp-body { scrollbar-width: thin; scrollbar-color: var(--grid) transparent; }
  #log { max-height: 520px; overflow-y: auto; }
  .log .row {
    display: flex;
    gap: 8px;
    padding: 5px 16px;
    border-top: 1px solid var(--grid);
    font-size: 12px;
    align-items: baseline;
  }
  #log .row { animation: row-in 0.35s ease backwards; }
  @keyframes row-in { from { opacity: 0; transform: translateX(4px); } }
  .log .time {
    color: var(--ink-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    white-space: nowrap;
  }
  .log .name { flex: 1; color: var(--ink); word-break: break-all; }
  .log .dur {
    color: var(--ink-secondary);
    font-family: var(--font-mono);
    font-size: 11px;
    white-space: nowrap;
  }
  .log .row.error { box-shadow: inset 2px 0 0 var(--critical); }
  .log .row.error .name { color: var(--critical); }
  .log .row.lifecycle .name { color: var(--ink-secondary); }
  .log .err-msg { color: var(--critical); }
  .log .detail {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-secondary);
    word-break: break-all;
    margin-top: 1px;
  }
  .log .detail .k { color: var(--ink-muted); }

  /* Inspector side panel */
  #inspector {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 380px;
    max-width: 92vw;
    background: var(--surface);
    border-left: 1px solid var(--border);
    box-shadow: var(--overlay-shadow);
    transform: translateX(100%);
    visibility: hidden;
    transition: transform 0.2s ease, visibility 0.2s;
    z-index: 20;
    display: flex;
    flex-direction: column;
  }
  #inspector.open { transform: none; visibility: visible; }
  .insp-head {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 16px;
    border-bottom: 1px solid var(--grid);
  }
  .insp-head .insp-name { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; word-break: break-all; }
  .insp-head .insp-status { font-size: 12px; color: var(--ink-secondary); margin-top: 2px; }
  .insp-head .insp-status .glyph { font-size: 10px; }
  #insp-close {
    margin-left: auto;
    background: none;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--ink-secondary);
    font: inherit;
    font-size: 14px;
    line-height: 1;
    padding: 5px 9px;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
  }
  #insp-close:hover { color: var(--ink); border-color: var(--ink-faint); }
  #insp-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .insp-body { flex: 1; overflow-y: auto; padding-bottom: 12px; }
  .insp-body h3 {
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
    font-weight: 600;
    margin: 0;
    padding: 16px 16px 4px;
  }
  #insp-summary { padding-top: 10px; }
  .i-row {
    display: flex;
    justify-content: space-between;
    padding: 2px 16px;
    font-size: 12px;
    color: var(--ink-secondary);
  }
  .i-row b {
    color: var(--ink);
    font-weight: 500;
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  #insp-methods table { font-size: 12px; }
  #insp-methods thead th { font-size: 10px; }
  .empty-note {
    padding: 4px 16px 6px;
    color: var(--ink-muted);
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 12px;
  }

  #tooltip {
    position: fixed;
    display: none;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(20, 20, 19, 0.18);
    padding: 10px 12px;
    font-size: 12px;
    pointer-events: none;
    z-index: 10;
    max-width: 280px;
  }
  #tooltip .t-name { font-weight: 600; margin-bottom: 4px; }
  #tooltip .t-row { display: flex; justify-content: space-between; gap: 16px; color: var(--ink-secondary); }
  #tooltip .t-row b {
    color: var(--ink);
    font-weight: 500;
    font-family: var(--font-mono);
    font-size: 11.5px;
  }

  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<header>
  <svg class="mark" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
    <path d="M7 6.5 L15 11 M7 15.5 L15 11" stroke="var(--ink-faint)" stroke-width="1.5" fill="none"/>
    <circle cx="6" cy="6" r="3" fill="#6a9bcc"/>
    <circle cx="6" cy="16" r="3" fill="#788c5d"/>
    <circle cx="16" cy="11" r="3.5" fill="#d97757"/>
  </svg>
  <h1>composed-di</h1>
  <span class="sub">service dashboard</span>
  <span id="conn" class="down">connecting…</span>
</header>

<div class="tiles">
  <div class="tile"><div class="label">Services ready</div><div class="value" id="tile-ready">–</div></div>
  <div class="tile"><div class="label">Method calls</div><div class="value" id="tile-calls">–</div></div>
  <div class="tile"><div class="label">Avg call</div><div class="value" id="tile-avg">–</div></div>
  <div class="tile"><div class="label">Errors</div><div class="value" id="tile-errors">–</div></div>
</div>

<main>
  <div>
    <div class="panel" id="graph-panel">
      <h2>Dependency graph</h2>
      <div id="graph-host"><div id="graph-empty">Waiting for module…</div></div>
      <div class="legend">
        <span><span class="glyph" style="color:var(--busy)">◐</span> initializing</span>
        <span><span class="glyph" style="color:var(--good)">●</span> ready</span>
        <span><span class="glyph" style="color:var(--critical)">✕</span> error</span>
        <span><span class="glyph" style="color:var(--ink-muted)">◌</span> disposed</span>
        <span><span class="glyph" style="color:var(--accent)">━</span> edge / node flash = live method call</span>
        <span class="hint">click a node to inspect its calls</span>
      </div>
    </div>
    <div class="panel" style="margin-top:14px">
      <h2>Services</h2>
      <table>
        <thead><tr>
          <th>Service</th><th>Status</th>
          <th class="num">Init ms</th><th class="num">Calls</th>
          <th class="num">Avg ms</th><th class="num">Errors</th>
        </tr></thead>
        <tbody id="service-rows"></tbody>
      </table>
    </div>
  </div>
  <div class="panel">
    <h2>Event log</h2>
    <div id="log" class="log"></div>
  </div>
</main>
<aside id="inspector" aria-label="Service inspector">
  <div class="insp-head">
    <div>
      <div class="insp-name" id="insp-name"></div>
      <div class="insp-status" id="insp-status"></div>
    </div>
    <button id="insp-close" aria-label="Close inspector" title="Close (Esc)">&#x2715;</button>
  </div>
  <div class="insp-body">
    <div id="insp-summary"></div>
    <h3>Methods</h3>
    <div id="insp-methods"></div>
    <h3>Call history</h3>
    <div id="insp-history" class="log"></div>
  </div>
</aside>
<div id="tooltip"></div>

<script>
(function () {
  'use strict';

  var theme = new URLSearchParams(location.search).get('theme');
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme);
  }

  var GLYPHS = {
    pending: '\\u25CB',       /* ○ */
    initializing: '\\u25D0',  /* ◐ */
    ready: '\\u25CF',         /* ● */
    error: '\\u2715',         /* ✕ */
    disposed: '\\u25CC'       /* ◌ */
  };
  var NODE_W = 176, NODE_H = 56, COL_W = 248, ROW_H = 84, PAD = 24;
  var MAX_LOG_ROWS = 200;
  var MAX_HISTORY = 100;  /* completed calls kept per service for the inspector */

  var state = { nodes: [], edges: [], services: {} };
  var selectedService = null;  /* service whose table row is expanded */
  var inspected = null;        /* service shown in the inspector side panel */
  var callHistory = {};        /* service name -> completed calls, newest first */
  var nodeEls = {};   /* service name -> { group, statusText, glyph } */
  var edgeEls = {};   /* "from\\u0000to" -> path element */
  var flashTimers = {};

  function $(id) { return document.getElementById(id); }
  function svgEl(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }
  function fmtMs(ms) {
    if (ms == null) return '–';
    if (ms < 1) return ms.toFixed(2);
    if (ms < 100) return ms.toFixed(1);
    return String(Math.round(ms));
  }
  function fmtTime(epoch) {
    var d = new Date(epoch);
    function p(n, w) { return String(n).padStart(w, '0'); }
    return p(d.getHours(), 2) + ':' + p(d.getMinutes(), 2) + ':' + p(d.getSeconds(), 2) + '.' + p(d.getMilliseconds(), 3);
  }

  /* ---------- graph layout: rank = longest path to a leaf ---------- */

  /** Only services whose initialization has at least started are drawn. */
  function isShown(name) {
    var stats = state.services[name];
    return !!stats && stats.status !== 'pending';
  }

  function computeRanks(nodes) {
    var deps = {};
    nodes.forEach(function (n) { deps[n.name] = []; });
    state.edges.forEach(function (e) {
      if (deps[e.from] && e.to in deps) deps[e.from].push(e.to);
    });
    var ranks = {}, visiting = {};
    function rankOf(name) {
      if (name in ranks) return ranks[name];
      if (visiting[name]) return 0; /* cycle guard; modules validate anyway */
      visiting[name] = true;
      var r = 0;
      deps[name].forEach(function (d) { r = Math.max(r, rankOf(d) + 1); });
      visiting[name] = false;
      ranks[name] = r;
      return r;
    }
    nodes.forEach(function (n) { rankOf(n.name); });
    return ranks;
  }

  function renderGraph() {
    var host = $('graph-host');
    host.textContent = '';
    nodeEls = {};
    edgeEls = {};
    var shown = state.nodes.filter(function (n) { return isShown(n.name); });
    if (!shown.length) {
      var empty = document.createElement('div');
      empty.id = 'graph-empty';
      empty.textContent = state.nodes.length
        ? 'No services initialized yet \\u2014 nodes appear when initialization starts.'
        : 'No services yet \\u2014 waiting for an application to connect.';
      host.appendChild(empty);
      return;
    }

    var ranks = computeRanks(shown);
    var columns = {};
    var maxRank = 0;
    shown.forEach(function (n) {
      var r = ranks[n.name];
      maxRank = Math.max(maxRank, r);
      (columns[r] = columns[r] || []).push(n.name);
    });
    Object.keys(columns).forEach(function (r) { columns[r].sort(); });

    var tallest = 0;
    Object.keys(columns).forEach(function (r) { tallest = Math.max(tallest, columns[r].length); });
    var width = PAD * 2 + maxRank * COL_W + NODE_W;
    var height = PAD * 2 + (tallest - 1) * ROW_H + NODE_H;

    var pos = {};
    Object.keys(columns).forEach(function (r) {
      var names = columns[r];
      var colH = (names.length - 1) * ROW_H + NODE_H;
      var y0 = PAD + (height - PAD * 2 - colH) / 2;
      names.forEach(function (name, i) {
        pos[name] = { x: PAD + Number(r) * COL_W, y: y0 + i * ROW_H };
      });
    });

    var svg = svgEl('svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Service dependency graph');

    /* Edges first, under the nodes. Arrow points at the dependency. */
    var defs = svgEl('defs');
    var marker = svgEl('marker');
    marker.setAttribute('id', 'arrow');
    marker.setAttribute('viewBox', '0 0 8 8');
    marker.setAttribute('refX', '7');
    marker.setAttribute('refY', '4');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto-start-reverse');
    var arrowPath = svgEl('path');
    arrowPath.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
    arrowPath.setAttribute('fill', 'context-stroke');
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    state.edges.forEach(function (e) {
      var from = pos[e.from], to = pos[e.to];
      if (!from || !to) return;
      var x1 = from.x, y1 = from.y + NODE_H / 2;
      var x2 = to.x + NODE_W + 6, y2 = to.y + NODE_H / 2;
      var mid = (x1 - x2) / 2;
      var path = svgEl('path');
      path.setAttribute('class', 'edge');
      path.setAttribute('marker-end', 'url(#arrow)');
      path.setAttribute('d',
        'M ' + x1 + ' ' + y1 +
        ' C ' + (x1 - mid) + ' ' + y1 + ' ' + (x2 + mid) + ' ' + y2 +
        ' ' + x2 + ' ' + y2);
      svg.appendChild(path);
      edgeEls[e.from + '\\u0000' + e.to] = path;
    });

    shown.forEach(function (n) {
      var p = pos[n.name];
      var g = svgEl('g');
      g.setAttribute('transform', 'translate(' + p.x + ' ' + p.y + ')');

      var rect = svgEl('rect');
      rect.setAttribute('width', NODE_W);
      rect.setAttribute('height', NODE_H);
      rect.setAttribute('rx', 8);
      g.appendChild(rect);

      var label = svgEl('text');
      label.setAttribute('x', 12);
      label.setAttribute('y', 23);
      label.textContent = n.name.length > 20 ? n.name.slice(0, 19) + '…' : n.name;
      g.appendChild(label);

      var glyph = svgEl('text');
      glyph.setAttribute('class', 'glyph');
      glyph.setAttribute('x', 12);
      glyph.setAttribute('y', 42);
      g.appendChild(glyph);

      var status = svgEl('text');
      status.setAttribute('class', 'status');
      status.setAttribute('x', 26);
      status.setAttribute('y', 42);
      g.appendChild(status);

      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', 'Inspect ' + n.name);
      g.addEventListener('mousemove', function (ev) { showTooltip(n.name, ev); });
      g.addEventListener('mouseleave', hideTooltip);
      g.addEventListener('click', function () { inspect(n.name); });
      g.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          inspect(n.name);
        }
      });

      svg.appendChild(g);
      nodeEls[n.name] = { group: g, statusText: status, glyph: glyph };
      applyNodeState(n.name);
    });

    host.appendChild(svg);
  }

  function applyNodeState(name) {
    var el = nodeEls[name];
    var stats = state.services[name];
    if (!el || !stats) return;
    var flashing = el.group.classList.contains('flash');
    el.group.setAttribute('class', 'node ' + stats.status
      + (flashing ? ' flash' : '')
      + (name === inspected ? ' selected' : ''));
    el.glyph.textContent = GLYPHS[stats.status] || '';
    var line = stats.status;
    if (stats.calls > 0) {
      line += ' \\u00B7 ' + stats.calls + ' call' + (stats.calls === 1 ? '' : 's');
    } else if (stats.status === 'ready' && stats.initMs != null) {
      line += ' \\u00B7 init ' + fmtMs(stats.initMs) + 'ms';
    }
    el.statusText.textContent = line;
  }

  function flash(el, key) {
    if (!el) return;
    el.classList.add('active');
    el.classList.add('flash');
    clearTimeout(flashTimers[key]);
    flashTimers[key] = setTimeout(function () {
      el.classList.remove('active');
      el.classList.remove('flash');
    }, 450);
  }

  /* ---------- tooltip ---------- */

  function showTooltip(name, ev) {
    var stats = state.services[name];
    if (!stats) return;
    var tip = $('tooltip');
    var avg = stats.calls > 0 ? stats.totalCallMs / stats.calls : null;
    tip.textContent = '';
    var title = document.createElement('div');
    title.className = 't-name';
    title.textContent = name;
    tip.appendChild(title);
    [
      ['Status', stats.status],
      ['Init', stats.initMs == null ? '–' : fmtMs(stats.initMs) + ' ms'],
      ['Calls', String(stats.calls)],
      ['Avg call', avg == null ? '–' : fmtMs(avg) + ' ms'],
      ['Errors', String(stats.errors)]
    ].forEach(function (pair) {
      var row = document.createElement('div');
      row.className = 't-row';
      var k = document.createElement('span');
      k.textContent = pair[0];
      var v = document.createElement('b');
      v.textContent = pair[1];
      row.appendChild(k);
      row.appendChild(v);
      tip.appendChild(row);
    });
    tip.style.display = 'block';
    var x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + tip.offsetWidth > window.innerWidth - 8) x = ev.clientX - tip.offsetWidth - 14;
    if (y + tip.offsetHeight > window.innerHeight - 8) y = ev.clientY - tip.offsetHeight - 14;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTooltip() { $('tooltip').style.display = 'none'; }

  /* ---------- tiles + table ---------- */

  function renderSummary() {
    var names = Object.keys(state.services);
    var ready = 0, calls = 0, errors = 0, callMs = 0;
    names.forEach(function (n) {
      var s = state.services[n];
      if (s.status === 'ready') ready++;
      calls += s.calls;
      errors += s.errors;
      callMs += s.totalCallMs;
    });
    $('tile-ready').innerHTML = '';
    $('tile-ready').appendChild(document.createTextNode(ready + ''));
    var total = document.createElement('small');
    total.textContent = ' / ' + names.length;
    $('tile-ready').appendChild(total);
    $('tile-calls').textContent = String(calls);
    $('tile-avg').textContent = calls > 0 ? fmtMs(callMs / calls) + ' ms' : '–';
    $('tile-errors').textContent = String(errors);
    $('tile-errors').className = 'value' + (errors > 0 ? ' bad' : '');

    var tbody = $('service-rows');
    tbody.textContent = '';
    names.sort().forEach(function (n) {
      var s = state.services[n];
      var selected = n === selectedService;
      var tr = document.createElement('tr');
      tr.className = 'svc-row' + (selected ? ' selected' : '');
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-expanded', selected ? 'true' : 'false');
      tr.addEventListener('click', function () { toggleService(n); });
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          toggleService(n);
        }
      });
      function cell(text, cls) {
        var td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        return td;
      }
      var nameCell = cell('');
      var caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = selected ? '\\u25BE' : '\\u25B8'; /* ▾ / ▸ */
      nameCell.appendChild(caret);
      nameCell.appendChild(document.createTextNode(n));
      tr.appendChild(nameCell);
      var status = cell('');
      var glyph = document.createElement('span');
      glyph.className = 'glyph';
      glyph.textContent = GLYPHS[s.status] + ' ';
      var color = { ready: 'var(--good)', initializing: 'var(--busy)', error: 'var(--critical)' }[s.status];
      glyph.style.color = color || 'var(--ink-muted)';
      status.appendChild(glyph);
      status.appendChild(document.createTextNode(s.status));
      tr.appendChild(status);
      tr.appendChild(cell(fmtMs(s.initMs), 'num'));
      tr.appendChild(cell(String(s.calls), 'num'));
      tr.appendChild(cell(s.calls > 0 ? fmtMs(s.totalCallMs / s.calls) : '–', 'num'));
      tr.appendChild(cell(String(s.errors), 'num' + (s.errors > 0 ? ' err' : '')));
      tbody.appendChild(tr);
      if (selected) tbody.appendChild(methodDetailRow(s));
    });
  }

  /* ---------- per-method drill-down ---------- */

  function toggleService(name) {
    selectedService = selectedService === name ? null : name;
    renderSummary();
  }

  /** A per-method stats table for a service, or null when it has none. */
  function methodsTable(methods) {
    var names = Object.keys(methods);
    if (!names.length) return null;
    names.sort(function (a, b) {
      return methods[b].calls - methods[a].calls || a.localeCompare(b);
    });
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    [['Method'], ['Calls', 'num'], ['Avg ms', 'num'], ['Last ms', 'num'], ['Errors', 'num']]
      .forEach(function (h) {
        var th = document.createElement('th');
        if (h[1]) th.className = h[1];
        th.textContent = h[0];
        headRow.appendChild(th);
      });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var body = document.createElement('tbody');
    names.forEach(function (m) {
      var stat = methods[m];
      var row = document.createElement('tr');
      function cell(text, cls) {
        var c = document.createElement('td');
        if (cls) c.className = cls;
        c.textContent = text;
        return c;
      }
      row.appendChild(cell(m));
      row.appendChild(cell(String(stat.calls), 'num'));
      row.appendChild(cell(fmtMs(stat.totalMs / stat.calls), 'num'));
      row.appendChild(cell(fmtMs(stat.lastMs), 'num'));
      row.appendChild(cell(String(stat.errors), 'num' + (stat.errors > 0 ? ' err' : '')));
      body.appendChild(row);
    });
    table.appendChild(body);
    return table;
  }

  /** The expanded row under a selected service: its method-call breakdown. */
  function methodDetailRow(stats) {
    var tr = document.createElement('tr');
    tr.className = 'method-detail';
    var td = document.createElement('td');
    td.colSpan = 6;
    var table = methodsTable(stats.methods || {});
    if (table) {
      var wrap = document.createElement('div');
      wrap.className = 'methods';
      wrap.appendChild(table);
      td.appendChild(wrap);
    } else {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No method calls yet.';
      td.appendChild(empty);
    }
    tr.appendChild(td);
    return tr;
  }

  /* ---------- inspector side panel ---------- */

  /** Opens the panel for a service; same service (or null) closes it. */
  function inspect(name) {
    inspected = (name === null || inspected === name) ? null : name;
    renderInspector();
    Object.keys(nodeEls).forEach(function (n) { applyNodeState(n); });
  }

  function renderInspector() {
    var panel = $('inspector');
    var stats = inspected ? state.services[inspected] : null;
    if (!stats) {
      inspected = null;
      panel.classList.remove('open');
      return;
    }
    panel.classList.add('open');
    $('insp-name').textContent = inspected;

    var status = $('insp-status');
    status.textContent = '';
    var glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = GLYPHS[stats.status] + ' ';
    var color = { ready: 'var(--good)', initializing: 'var(--busy)', error: 'var(--critical)' }[stats.status];
    glyph.style.color = color || 'var(--ink-muted)';
    status.appendChild(glyph);
    status.appendChild(document.createTextNode(stats.status));

    var summary = $('insp-summary');
    summary.textContent = '';
    var avg = stats.calls > 0 ? stats.totalCallMs / stats.calls : null;
    [
      ['Init', stats.initMs == null ? '–' : fmtMs(stats.initMs) + ' ms'],
      ['Calls', String(stats.calls)],
      ['Avg call', avg == null ? '–' : fmtMs(avg) + ' ms'],
      ['Errors', String(stats.errors)]
    ].forEach(function (pair) {
      var row = document.createElement('div');
      row.className = 'i-row';
      var k = document.createElement('span');
      k.textContent = pair[0];
      var v = document.createElement('b');
      v.textContent = pair[1];
      row.appendChild(k);
      row.appendChild(v);
      summary.appendChild(row);
    });

    var methodsHost = $('insp-methods');
    methodsHost.textContent = '';
    var table = methodsTable(stats.methods || {});
    if (table) methodsHost.appendChild(table);
    else methodsHost.appendChild(emptyNote('No method calls yet.'));

    var historyHost = $('insp-history');
    historyHost.textContent = '';
    var entries = callHistory[inspected] || [];
    if (!entries.length) {
      historyHost.appendChild(emptyNote('No calls recorded yet.'));
    } else {
      entries.forEach(function (entry) {
        historyHost.appendChild(historyRow(entry));
      });
    }
  }

  function emptyNote(text) {
    var div = document.createElement('div');
    div.className = 'empty-note';
    div.textContent = text;
    return div;
  }

  function historyRow(entry) {
    var row = document.createElement('div');
    row.className = 'row' + (entry.error ? ' error' : '');

    var time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(entry.time);
    row.appendChild(time);

    var name = document.createElement('span');
    name.className = 'name';
    var text = entry.method;
    if (entry.parentService && entry.parentService !== inspected) {
      text = entry.parentService + ' \\u2192 ' + text;
    }
    name.textContent = text;
    /* "[]" (no arguments) and "undefined" (void return) carry no signal. */
    if (entry.args != null && entry.args !== '[]') {
      name.appendChild(detailLine('args', entry.args));
    }
    if (entry.result != null && entry.result !== 'undefined') {
      name.appendChild(detailLine('\\u2192', entry.result));
    }
    if (entry.error) {
      var err = document.createElement('div');
      err.className = 'err-msg';
      err.textContent = '\\u2715 ' + entry.error;
      name.appendChild(err);
    }
    row.appendChild(name);

    var dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = fmtMs(entry.durationMs) + ' ms';
    row.appendChild(dur);
    return row;
  }

  function detailLine(label, text) {
    var div = document.createElement('div');
    div.className = 'detail';
    var k = document.createElement('span');
    k.className = 'k';
    k.textContent = label + ' ';
    div.appendChild(k);
    div.appendChild(document.createTextNode(text));
    return div;
  }

  /** Keeps the per-service history the inspector shows, newest first. */
  function recordCall(wire) {
    if (wire.kind !== 'call' || wire.span.type !== 'end' || !wire.service) return;
    var list = callHistory[wire.service] = callHistory[wire.service] || [];
    list.unshift({
      method: wire.method,
      parentService: wire.parentService,
      time: wire.span.time,
      durationMs: wire.span.durationMs,
      error: wire.span.error,
      args: wire.args,
      result: wire.span.result != null ? wire.span.result : null
    });
    if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
  }

  /* ---------- event log ---------- */

  function logEvent(wire) {
    var span = wire.span;
    var isEnd = span.type === 'end';
    /* Log every completed span, plus initialize starts (they can be slow). */
    if (!isEnd && wire.kind !== 'initialize') return;

    var row = document.createElement('div');
    row.className = 'row'
      + (isEnd && span.error ? ' error' : '')
      + (wire.kind !== 'call' ? ' lifecycle' : '');

    var time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(span.time);
    row.appendChild(time);

    var name = document.createElement('span');
    name.className = 'name';
    var text = (wire.service != null ? wire.service + '.' : '') + wire.method;
    if (wire.parentService && wire.parentService !== wire.service) {
      text = wire.parentService + ' \\u2192 ' + text;
    }
    name.textContent = text;
    if (isEnd && span.error) {
      var err = document.createElement('div');
      err.className = 'err-msg';
      err.textContent = '\\u2715 ' + span.error;
      name.appendChild(err);
    }
    row.appendChild(name);

    var dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = isEnd ? fmtMs(span.durationMs) + ' ms' : 'started…';
    row.appendChild(dur);

    var log = $('log');
    log.insertBefore(row, log.firstChild);
    while (log.children.length > MAX_LOG_ROWS) log.removeChild(log.lastChild);
  }

  /* ---------- live updates ---------- */

  function applyEvent(wire) {
    if (wire.service && wire.stats) {
      var wasDrawn = wire.service in nodeEls;
      state.services[wire.service] = wire.stats;
      if (isShown(wire.service) !== wasDrawn) {
        renderGraph(); /* the node just became visible (or vanished) */
      } else {
        applyNodeState(wire.service);
      }
    }
    if (wire.kind === 'call' && wire.service) {
      var el = nodeEls[wire.service];
      if (el) flash(el.group, 'n:' + wire.service);
      if (wire.parentService && wire.parentService !== wire.service) {
        flash(edgeEls[wire.parentService + '\\u0000' + wire.service], 'e:' + wire.parentService + '>' + wire.service);
      }
    }
    recordCall(wire);
    logEvent(wire);
    renderSummary();
    if (inspected && wire.service === inspected) renderInspector();
  }

  function connect() {
    var es = new EventSource('/events');
    es.addEventListener('open', function () {
      var conn = $('conn');
      conn.className = 'live';
      conn.textContent = 'live';
    });
    es.addEventListener('error', function () {
      var conn = $('conn');
      conn.className = 'down';
      conn.textContent = 'reconnecting…';
    });
    es.addEventListener('snapshot', function (ev) {
      var snap = JSON.parse(ev.data);
      state.nodes = snap.nodes;
      state.edges = snap.edges;
      state.services = snap.services;
      callHistory = {};
      /* recent is oldest-first; recordCall unshifts, so newest ends up first */
      snap.recent.forEach(recordCall);
      renderGraph();
      renderSummary();
      renderInspector(); /* refreshes, or closes if the service is gone */
      $('log').textContent = '';
      snap.recent.forEach(logEvent);
    });
    es.addEventListener('span', function (ev) {
      applyEvent(JSON.parse(ev.data));
    });
  }

  $('insp-close').addEventListener('click', function () { inspect(null); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') inspect(null);
  });

  connect();
})();
</script>
</body>
</html>
`
