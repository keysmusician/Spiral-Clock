import Plotly from 'plotly.js-dist-min';

const TAU = 2 * Math.PI;
// Seconds, minutes, hours, days. Amplitude scales with period so each
// larger scale forms a wider coil, as in the reference graph.
const PERIODS = [1, 60, 3600, 86400];
const waves = PERIODS.map((p) => ({ f: TAU / p, amp: p / TAU }));

const sumWaves = (fn, x) => waves.reduce((s, w) => s + w.amp * fn(w.f * x), 0);
const signal = (x) => ({ y: sumWaves(Math.sin, x), z: sumWaves(Math.cos, x) });

const SAMPLES = 1500;
const MIN_HALF = 0.5; // seconds
const MAX_HALF = 86400 * 2;
let halfSpan = 30; // seconds shown on each side of "now"

let pendingCamera = null; // applied by the next redraw, no extra relayout
let camera = { eye: { x: -0.9, y: -0.9, z: 0.6 } };

const nowSeconds = () => Date.now() / 1000;

function spanLabel(h) {
  const s = 2 * h;
  if (s < 120) return `${s.toFixed(1)} s`;
  if (s < 7200) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

const axisBase = {
  autorange: false, showgrid: false, zeroline: false, showline: false,
  showticklabels: false, showspikes: false, showbackground: false, title: { text: '' }, ticks: '',
};

// Cubic ranges centered on the current point keep it fixed in the view.
function ranges(now, anchor) {
  const c = signal(now);
  const r = (center) => [center - halfSpan, center + halfSpan];
  return { c, x: [now - anchor - halfSpan, now - anchor + halfSpan], y: r(c.y), z: r(c.z) };
}

// The curve is static geometry (x = seconds since `anchor`) covering more than the
// visible window. It is only rebuilt on zoom or when "now" drifts from the anchor.
function build(anchor) {
  const reach = halfSpan * 1.25;
  const xs = new Array(SAMPLES), ys = new Array(SAMPLES), zs = new Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const dx = -reach + (2 * reach * i) / (SAMPLES - 1);
    const s = signal(anchor + dx);
    xs[i] = dx; ys[i] = s.y; zs[i] = s.z;
  }
  // Split at the anchor; the two halves share the middle sample.
  const mid = Math.floor(SAMPLES / 2);
  const past = (arr) => arr.slice(0, mid + 1);
  const future = (arr) => arr.slice(mid);
  const rg = ranges(anchor, anchor);
  const data = [
    { type: 'scatter3d', mode: 'lines', x: past(xs), y: past(ys), z: past(zs),
      line: { color: '#1a3a7a', width: 3 }, opacity: 0.35, hoverinfo: 'skip' },
    { type: 'scatter3d', mode: 'lines', x: future(xs), y: future(ys), z: future(zs),
      line: { color: '#2f8cff', width: 4 }, hoverinfo: 'skip' },
    { type: 'scatter3d', mode: 'markers', x: [0], y: [rg.c.y], z: [rg.c.z],
      marker: { color: '#ffffff', size: 5, line: { width: 0 } }, hoverinfo: 'skip' },
  ];
  const layout = {
    paper_bgcolor: '#111', margin: { l: 0, r: 0, t: 0, b: 0 }, showlegend: false, autosize: true,
    uirevision: 'keep',
    scene: {
      aspectmode: 'cube', domain: { x: [0, 1], y: [0, 1] },
      camera: pendingCamera ?? plotEl._fullLayout?.scene?.camera ?? camera,
      xaxis: { ...axisBase, range: rg.x },
      yaxis: { ...axisBase, range: rg.y },
      zaxis: { ...axisBase, range: rg.z },
    },
  };
  return { data, layout };
}

const plotEl = document.getElementById('plot');
const timeEl = document.getElementById('time');
const spanEl = document.getElementById('span');

// Replace Plotly's camera zoom with time-span zoom.
plotEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  e.stopPropagation();
  halfSpan = Math.min(MAX_HALF, Math.max(MIN_HALF, halfSpan * Math.exp(e.deltaY * 0.002)));
}, { capture: true, passive: false });

// Looking down each axis; the z view needs a different "up" to avoid a degenerate camera.
const VIEWS = {
  yz: { eye: { x: -2, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  xz: { eye: { x: 0, y: 2, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  xy: { eye: { x: 0, y: 0, z: 2 }, up: { x: 0, y: 1, z: 0 } },
};
document.querySelectorAll('#views button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const v = VIEWS[btn.dataset.view];
    pendingCamera = { ...v, center: { x: 0, y: 0, z: 0 } };
    // Apply immediately on the GL scene instead of waiting for the next redraw.
    const p = pendingCamera;
    const glplot = plotEl._fullLayout?.scene?._scene?.glplot;
    if (glplot) {
      glplot.camera.lookAt([p.eye.x, p.eye.y, p.eye.z], [0, 0, 0], [p.up.x, p.up.y, p.up.z]);
      glplot.redraw();
    }
  });
});

const config = { responsive: true, displayModeBar: false, displaylogo: false, scrollZoom: false };
let first = true;
let busy = false;
// Pause redraws while rotating so they don't fight Plotly's own camera drag.
let dragging = false;
plotEl.addEventListener('pointerdown', () => { dragging = true; });
window.addEventListener('pointerup', () => { setTimeout(() => { dragging = false; }, 150); });
let anchor = null;
let builtHalfSpan = null;

async function frame() {
  const now = nowSeconds();
  timeEl.textContent = new Date(now * 1000).toLocaleTimeString();
  spanEl.textContent = `visible span: ${spanLabel(halfSpan)} (scroll to zoom)`;
  if (!busy && !dragging) {
    busy = true;
    try {
      if (first || halfSpan !== builtHalfSpan || Math.abs(now - anchor) > halfSpan * 0.01) {
        anchor = now;
        builtHalfSpan = halfSpan;
        const { data, layout } = build(anchor);
        if (first) { await Plotly.newPlot(plotEl, data, layout, config); first = false; }
        else await Plotly.react(plotEl, data, layout, config);
        pendingCamera = null;
      } else {
        const rg = ranges(now, anchor);
        await Plotly.update(plotEl,
          { x: [[now - anchor]], y: [[rg.c.y]], z: [[rg.c.z]] },
          { 'scene.xaxis.range': rg.x, 'scene.yaxis.range': rg.y, 'scene.zaxis.range': rg.z },
          [2]);
      }
    } finally { busy = false; }
  }
  requestAnimationFrame(frame);
}
frame();
