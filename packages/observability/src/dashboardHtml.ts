/**
 * The dashboard page, served at "/". Self-contained: no build step, no CDN.
 *
 * Connects to "/events" (Server-Sent Events), receives a full snapshot, then
 * live span events. Renders the dependency graph as SVG (services laid out in
 * dependency ranks, dependencies on the left), a stat-tile row, a services
 * table, and an event log. Service state is shown as a status glyph + word,
 * never color alone.
 */
export function renderDashboardHtml(): string {
  return HTML;
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>composed-di dashboard</title>
<style>
  :root {
    --page:            #f9f9f7;
    --surface:         #fcfcfb;
    --ink:             #0b0b0b;
    --ink-secondary:   #52514e;
    --ink-muted:       #898781;
    --grid:            #e1e0d9;
    --border:          rgba(11, 11, 11, 0.10);
    --accent:          #2a78d6;
    --good:            #0ca30c;
    --warning:         #fab219;
    --critical:        #d03b3b;
  }
  /* Dark values apply via the system preference, or ?theme=dark|light. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --page:            #0d0d0d;
      --surface:         #1a1a19;
      --ink:             #ffffff;
      --ink-secondary:   #c3c2b7;
      --ink-muted:       #898781;
      --grid:            #2c2c2a;
      --border:          rgba(255, 255, 255, 0.10);
      --accent:          #3987e5;
    }
  }
  :root[data-theme="dark"] {
    --page:            #0d0d0d;
    --surface:         #1a1a19;
    --ink:             #ffffff;
    --ink-secondary:   #c3c2b7;
    --ink-muted:       #898781;
    --grid:            #2c2c2a;
    --border:          rgba(255, 255, 255, 0.10);
    --accent:          #3987e5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--ink);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 16px 20px 0;
  }
  header h1 { font-size: 16px; font-weight: 650; margin: 0; }
  header .sub { color: var(--ink-muted); font-size: 12px; }
  #conn {
    margin-left: auto;
    font-size: 12px;
    color: var(--ink-secondary);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 10px;
  }
  #conn.live::before { content: "● "; color: var(--good); }
  #conn.down::before { content: "● "; color: var(--critical); }

  .tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 14px 20px;
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 16px;
    min-width: 132px;
  }
  .tile .label {
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-muted);
  }
  .tile .value { font-size: 24px; font-weight: 650; margin-top: 2px; }
  .tile .value small { font-size: 13px; font-weight: 400; color: var(--ink-secondary); }

  main {
    display: grid;
    grid-template-columns: 1fr 340px;
    gap: 12px;
    padding: 0 20px 20px;
    align-items: start;
  }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .panel h2 {
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-muted);
    font-weight: 600;
    margin: 0;
    padding: 10px 14px;
    border-bottom: 1px solid var(--grid);
  }
  #graph-panel svg { display: block; width: 100%; }
  #graph-empty { padding: 32px; color: var(--ink-muted); text-align: center; }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    padding: 10px 14px;
    border-top: 1px solid var(--grid);
    font-size: 12px;
    color: var(--ink-secondary);
  }
  .legend .glyph { font-size: 11px; }

  /* Graph marks */
  .edge {
    fill: none;
    stroke: var(--grid);
    stroke-width: 1.5;
    transition: stroke 0.45s ease;
  }
  .edge.active { stroke: var(--accent); stroke-width: 2.5; transition: none; }
  .node rect {
    fill: var(--surface);
    stroke: var(--ink-muted);
    stroke-width: 1.5;
    rx: 6;
  }
  .node text { fill: var(--ink); font-size: 13px; font-weight: 600; }
  .node .status { fill: var(--ink-secondary); font-size: 11px; font-weight: 400; }
  .node .glyph { font-size: 10px; }
  .node.pending rect { stroke: var(--ink-muted); stroke-dasharray: 4 3; }
  .node.pending .glyph { fill: var(--ink-muted); }
  .node.initializing rect { stroke: var(--warning); animation: pulse 1s ease-in-out infinite; }
  .node.initializing .glyph { fill: var(--warning); }
  .node.ready rect { stroke: var(--good); }
  .node.ready .glyph { fill: var(--good); }
  .node.error rect { stroke: var(--critical); stroke-width: 2; }
  .node.error .glyph { fill: var(--critical); }
  .node.disposed rect { stroke: var(--grid); }
  .node.disposed .glyph { fill: var(--ink-muted); }
  .node.disposed text { fill: var(--ink-muted); }
  .node.flash rect { stroke: var(--accent); stroke-width: 2.5; }
  @keyframes pulse { 50% { stroke-opacity: 0.35; } }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 14px; border-top: 1px solid var(--grid); }
  thead th {
    border-top: none;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-muted);
    font-weight: 600;
  }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td .glyph { font-size: 10px; }

  /* Event log */
  #log { max-height: 520px; overflow-y: auto; }
  #log .row {
    display: flex;
    gap: 8px;
    padding: 5px 14px;
    border-top: 1px solid var(--grid);
    font-size: 12px;
    align-items: baseline;
  }
  #log .time { color: var(--ink-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  #log .name { flex: 1; color: var(--ink); word-break: break-all; }
  #log .dur { color: var(--ink-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
  #log .row.error .name { color: var(--critical); }
  #log .row.lifecycle .name { color: var(--ink-secondary); }
  #log .err-msg { color: var(--critical); }

  #tooltip {
    position: fixed;
    display: none;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
    padding: 8px 12px;
    font-size: 12px;
    pointer-events: none;
    z-index: 10;
    max-width: 280px;
  }
  #tooltip .t-name { font-weight: 650; margin-bottom: 4px; }
  #tooltip .t-row { display: flex; justify-content: space-between; gap: 16px; color: var(--ink-secondary); }
  #tooltip .t-row b { color: var(--ink); font-weight: 550; font-variant-numeric: tabular-nums; }

  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
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
        <span><span class="glyph" style="color:var(--ink-muted)">○</span> pending</span>
        <span><span class="glyph" style="color:var(--warning)">◐</span> initializing</span>
        <span><span class="glyph" style="color:var(--good)">●</span> ready</span>
        <span><span class="glyph" style="color:var(--critical)">✕</span> error</span>
        <span><span class="glyph" style="color:var(--ink-muted)">◌</span> disposed</span>
        <span><span class="glyph" style="color:var(--accent)">━</span> edge / node flash = live method call</span>
      </div>
    </div>
    <div class="panel" style="margin-top:12px">
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
    <div id="log"></div>
  </div>
</main>
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

  var state = { nodes: [], edges: [], services: {} };
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

  function computeRanks() {
    var deps = {};
    state.nodes.forEach(function (n) { deps[n.name] = []; });
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
    state.nodes.forEach(function (n) { rankOf(n.name); });
    return ranks;
  }

  function renderGraph() {
    var host = $('graph-host');
    host.textContent = '';
    nodeEls = {};
    edgeEls = {};
    if (!state.nodes.length) {
      var empty = document.createElement('div');
      empty.id = 'graph-empty';
      empty.textContent = 'No services yet \\u2014 waiting for an application to connect.';
      host.appendChild(empty);
      return;
    }

    var ranks = computeRanks();
    var columns = {};
    var maxRank = 0;
    state.nodes.forEach(function (n) {
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

    state.nodes.forEach(function (n) {
      var p = pos[n.name];
      var g = svgEl('g');
      g.setAttribute('transform', 'translate(' + p.x + ' ' + p.y + ')');

      var rect = svgEl('rect');
      rect.setAttribute('width', NODE_W);
      rect.setAttribute('height', NODE_H);
      rect.setAttribute('rx', 6);
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

      g.addEventListener('mousemove', function (ev) { showTooltip(n.name, ev); });
      g.addEventListener('mouseleave', hideTooltip);

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
    el.group.setAttribute('class', 'node ' + stats.status + (flashing ? ' flash' : ''));
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

    var tbody = $('service-rows');
    tbody.textContent = '';
    names.sort().forEach(function (n) {
      var s = state.services[n];
      var tr = document.createElement('tr');
      function cell(text, cls) {
        var td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        return td;
      }
      tr.appendChild(cell(n));
      var status = cell('');
      var glyph = document.createElement('span');
      glyph.className = 'glyph';
      glyph.textContent = GLYPHS[s.status] + ' ';
      var color = { ready: 'var(--good)', initializing: 'var(--warning)', error: 'var(--critical)' }[s.status];
      glyph.style.color = color || 'var(--ink-muted)';
      status.appendChild(glyph);
      status.appendChild(document.createTextNode(s.status));
      tr.appendChild(status);
      tr.appendChild(cell(fmtMs(s.initMs), 'num'));
      tr.appendChild(cell(String(s.calls), 'num'));
      tr.appendChild(cell(s.calls > 0 ? fmtMs(s.totalCallMs / s.calls) : '–', 'num'));
      tr.appendChild(cell(String(s.errors), 'num'));
      tbody.appendChild(tr);
    });
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
      var known = wire.service in state.services;
      state.services[wire.service] = wire.stats;
      if (!known) renderGraph();
      applyNodeState(wire.service);
    }
    if (wire.kind === 'call' && wire.service) {
      var el = nodeEls[wire.service];
      if (el) flash(el.group, 'n:' + wire.service);
      if (wire.parentService && wire.parentService !== wire.service) {
        flash(edgeEls[wire.parentService + '\\u0000' + wire.service], 'e:' + wire.parentService + '>' + wire.service);
      }
    }
    logEvent(wire);
    renderSummary();
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
      renderGraph();
      renderSummary();
      $('log').textContent = '';
      snap.recent.forEach(logEvent);
    });
    es.addEventListener('span', function (ev) {
      applyEvent(JSON.parse(ev.data));
    });
  }

  connect();
})();
</script>
</body>
</html>
`;
