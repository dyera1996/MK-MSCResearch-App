/* ===================== CONFIG ===================== */
const LS_KEY = 'papStudyV2';

const DEFAULT_SETTINGS = {
  maxPatients: 40,
  groupLabels: ['A', 'B', 'C', 'D', 'E'],
  groupTimes: [1, 10, 15, 60, 1440],
  groupDelays: [0, 0, 0, 0, 0]
};

const PARAMS = [
  { k: 'nuc', label: 'Nuclear staining' },
  { k: 'cyt', label: 'Cytoplasmic staining' },
  { k: 'mor', label: 'Cell morphology' },
  { k: 'bg', label: 'Background clarity' },
  { k: 'ovr', label: 'Overall adequacy' }
];

const DEFAULT_PROTOCOL = [
  { name: 'Re-wet in 95% ethanol', sec: 120 },
  { name: 'Rinse in tap water', sec: 30 },
  { name: 'Harris / Gill Hematoxylin', sec: 180 },
  { name: 'Rinse in tap water (or PBS)', sec: 30 },
  { name: '95% Ethanol — 10 dips', sec: 30 },
  { name: 'OG-6 stain', sec: 90 },
  { name: '95% Ethanol — 10 dips', sec: 30 },
  { name: 'EA-50 stain', sec: 150 },
  { name: '95% Ethanol — 10 dips, 2 changes', sec: 60 },
  { name: '100% Ethanol', sec: 60 },
  { name: 'Clear in xylene — 2 changes', sec: 240 },
  { name: 'Mount with DPX', sec: 0 }
];

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'fixing', label: 'Fixing' },
  { id: 'ready', label: 'Ready' },
  { id: 'drying', label: 'In container' },
  { id: 'staining', label: 'Staining' },
  { id: 'stained', label: 'To clear' },
  { id: 'cleared', label: 'To score' },
  { id: 'scored', label: 'Scored' }
];

/* ===================== STATE ===================== */
let state = { patients: [], batches: [], seqPatient: 0, seqBatch: 0, protocol: null, settings: null, protocolVersion: 1 };
let selected = new Set();
let expandedPatients = new Set();
let expandedProtocols = new Set();
let expandedSlideLists = new Set();
let audioCtx = null;
let tempScores = { o1: {}, o2: {} };
let patientFilter = 'all';
let patientSort = 'newest';
let tempProtocol = null;

/* ===================== UTIL ===================== */
const $ = id => document.getElementById(String(id).replace(/^#/, ''));

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function deepCopyProtocol(arr) { return arr.map(s => ({ name: s.name, sec: s.sec })); }
function deepCopySettings(s) {
  return {
    maxPatients: s.maxPatients,
    groupLabels: s.groupLabels.slice(),
    groupTimes: s.groupTimes.slice(),
    groupDelays: (s.groupDelays || s.groupLabels.map(() => 0)).slice()
  };
}
function deepEqualProtocol(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].sec !== b[i].sec) return false;
  }
  return true;
}

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) state = Object.assign(state, JSON.parse(raw));
  } catch (e) { console.warn('load failed', e); }
  if (!Array.isArray(state.protocol) || state.protocol.length === 0) {
    state.protocol = deepCopyProtocol(DEFAULT_PROTOCOL);
  }
  if (!state.settings || !Array.isArray(state.settings.groupLabels) || !Array.isArray(state.settings.groupTimes)) {
    state.settings = deepCopySettings(DEFAULT_SETTINGS);
  }
  if (!Array.isArray(state.settings.groupDelays) ||
    state.settings.groupDelays.length !== state.settings.groupLabels.length) {
    state.settings.groupDelays = state.settings.groupLabels.map(() => 0);
  }
  if (typeof state.settings.maxPatients !== 'number' || state.settings.maxPatients < 1) {
    state.settings.maxPatients = DEFAULT_SETTINGS.maxPatients;
  }
  if (typeof state.protocolVersion !== 'number') state.protocolVersion = 1;
  state.batches.forEach(b => {
    if (!Array.isArray(b.protocolSnapshot) || b.protocolSnapshot.length === 0) {
      b.protocolSnapshot = deepCopyProtocol(state.protocol);
      b.protocolVersion = state.protocolVersion;
    }
    if (!Array.isArray(b.stepLog)) b.stepLog = [];
  });
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
  catch (e) { toast('⚠️ Could not save — storage may be full'); }
}

function getGroups() {
  return state.settings.groupLabels.map((label, i) => ({
    id: label,
    minutes: state.settings.groupTimes[i] || 0,
    delaySec: state.settings.groupDelays[i] || 0
  }));
}
function getMaxPatients() { return state.settings.maxPatients || 40; }
function getTargetSlides() { return getMaxPatients() * getGroups().length; }

function allSlides() {
  const out = [];
  state.patients.forEach(p => p.slides.forEach(s => out.push({ p, s })));
  return out;
}
function findSlide(code) {
  for (const p of state.patients) for (const s of p.slides) if (s.code === code) return s;
  return null;
}
function patientOf(code) {
  for (const p of state.patients) if (p.slides.some(s => s.code === code)) return p;
  return null;
}
function findBatch(id) { return state.batches.find(b => b.id === id) || null; }
function batchProtocol(b) { return b.protocolSnapshot || state.protocol; }

function fmt(ms) {
  if (ms < 0) ms = 0;
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function timeAt(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + m + ' ' + ampm;
}
function clockHHMM(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + m + ' ' + ampm;
}
function fmtMin(m) {
  if (m < 60) return m + ' min';
  if (m < 1440) return (m / 60) + ' h';
  return (m / 1440) + ' day';
}
function fmtStepDuration(sec) {
  if (sec === 0) return 'manual';
  if (sec < 60) return sec + ' sec';
  const m = sec / 60;
  return Number.isInteger(m) ? m + ' min' : m.toFixed(1) + ' min';
}
function classify(total) {
  if (total >= 12) return 'Optimal';
  if (total >= 7) return 'Satisfactory';
  if (total >= 2) return 'Poor';
  return 'Non-diagnostic';
}
function toast(msg) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 5200);
  setTimeout(() => el.remove(), 5800);
}

/* ===================== SOUND ===================== */
function beep(times = 1) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      setTimeout(() => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.type = 'sine';
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.30, audioCtx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
        o.start(); o.stop(audioCtx.currentTime + 0.40);
      }, i * 450);
    }
  } catch (e) { /* no audio */ }
}
function testSound() { beep(2); toast('Two beeps = sound is working.'); }

/* ===================== TABS ===================== */
document.querySelectorAll('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    renderAll();
  });
});

function goToTab(tabName) {
  const btn = document.querySelector(`#tabs button[data-tab="${tabName}"]`);
  if (btn) btn.click();
}
function goToReceptionAndRegister() {
  goToTab('reception');
  setTimeout(() => openRegister(), 60);
}

/* ===================== MODALS ===================== */
function openRegister() {
  $('modal-register').classList.remove('hidden');
  setTimeout(() => $('f_age').focus(), 50);
}
function closeModal(id) { $(id).classList.add('hidden'); }
function closeProtocolEditor() {
  if (tempProtocol && !deepEqualProtocol(tempProtocol, state.protocol)) {
    if (!confirm('You have unsaved changes to the protocol. Discard them?')) return;
  }
  closeModal('modal-protocol');
  tempProtocol = null;
}

/* ===================== EXPAND TRACKING ===================== */
function toggleExpandPatient(pid) {
  if (expandedPatients.has(pid)) expandedPatients.delete(pid);
  else expandedPatients.add(pid);
  renderPatients();
}
function toggleProtocolExpand(bid) {
  if (expandedProtocols.has(bid)) expandedProtocols.delete(bid);
  else expandedProtocols.add(bid);
}
function toggleSlideListExpand(bid) {
  if (expandedSlideLists.has(bid)) expandedSlideLists.delete(bid);
  else expandedSlideLists.add(bid);
}

/* ===================== REGISTER ===================== */
function registerPatient(e) {
  e.preventDefault();
  const age = parseInt($('f_age').value, 10);
  if (!age || age < 18 || age > 60) { toast('Age must be between 18 and 60'); return; }

  const realCount = state.patients.filter(p => !p.simulated).length;
  const simCount = state.patients.filter(p => p.simulated).length;
  const maxP = getMaxPatients();

  if (realCount >= maxP) {
    let msg = `You have reached your target of ${maxP} real patients.\n\n`;
    if (simCount > 0) msg += `(${simCount} simulated patient${simCount > 1 ? 's' : ''} also in the app)\n\n`;
    msg += `Register an additional patient (P${String(state.seqPatient + 1).padStart(2, '0')}) anyway?\n\nTip: increase "Max patients" in Settings if this is intentional.`;
    if (!confirm(msg)) return;
  }

  state.seqPatient++;
  const id = 'P' + String(state.seqPatient).padStart(2, '0');
  const now = Date.now();
  const groups = getGroups();

  const slides = groups.map(g => ({
    code: `${id}-${g.id}`,
    group: g.id,
    fixMinutes: g.minutes,
    delaySec: g.delaySec,
    fixStart: null,
    fixEnd: null,
    fixEndActual: null,
    actualMinutes: null,
    status: 'pending',
    notified: false,
    scores: null
  }));

  state.patients.push({
    id,
    name: $('f_name').value.trim(),
    age,
    sex: $('f_sex').value,
    smoking: $('f_smoke').value,
    notes: $('f_notes').value.trim(),
    t0: null,
    slides,
    createdAt: now
  });

  save();
  $('regForm').reset();
  closeModal('modal-register');
  beep(1);
  toast(`${id} registered — go to Fixation and click each slide chip as you put it in`);
  renderAll();
}

function startSlide(code) {
  const s = findSlide(code);
  if (!s || s.status !== 'pending') return;
  const p = patientOf(code);
  const now = Date.now();
  s.fixStart = now;
  s.fixEnd = now + s.fixMinutes * 60000;
  s.status = 'fixing';
  s.notified = false;
  if (!p.t0 || now < p.t0) p.t0 = now;
  save();
  beep(1);
  toast(`${code} → in fixative at ${clockHHMM(now)} · pull at ${clockHHMM(s.fixEnd)}`);
  renderAll();
}

function startAllPending(pid) {
  const p = state.patients.find(x => x.id === pid);
  if (!p) return;
  const pending = p.slides.filter(s => s.status === 'pending');
  if (!pending.length) return;
  if (!confirm(`Start fixation for all ${pending.length} pending slide${pending.length > 1 ? 's' : ''} at the same time (now)?\n\nFor accurate timing, click each chip individually instead.`)) return;
  const now = Date.now();
  pending.forEach(s => {
    s.fixStart = now;
    s.fixEnd = now + s.fixMinutes * 60000;
    s.status = 'fixing';
    s.notified = false;
  });
  if (!p.t0 || now < p.t0) p.t0 = now;
  save();
  beep(1);
  toast(`${pid}: ${pending.length} slide${pending.length > 1 ? 's' : ''} started at ${clockHHMM(now)}`);
  renderAll();
}

function deletePatient(pid) {
  const p = state.patients.find(x => x.id === pid);
  if (!p) return;
  if (p.slides.some(s => s.status === 'fixing')) {
    toast('Cannot delete — patient has active fixation');
    return;
  }
  if (!confirm(`Delete ${pid} and all its slides/scores? This cannot be undone.`)) return;
  state.batches.forEach(b => {
    b.slides = b.slides.filter(c => !c.startsWith(pid + '-'));
  });
  state.patients = state.patients.filter(x => x.id !== pid);
  expandedPatients.delete(pid);
  save();
  renderAll();
  toast(`${pid} deleted`);
}

/* ===================== PRINT LOG ===================== */
function printFixationLog(pid) {
  const p = state.patients.find(x => x.id === pid);
  if (!p) return;
  const rows = p.slides.map(s => {
    let status = 'Pending', actual = '—', pullAt = '—', inAt = '—';
    if (s.fixStart) inAt = clockHHMM(s.fixStart);
    if (s.status !== 'pending') {
      pullAt = clockHHMM(s.fixEnd);
      if (s.actualMinutes != null) actual = s.actualMinutes.toFixed(2) + ' min';
      status = {
        fixing: 'Fixing', drying: 'In container', staining: 'Staining',
        stained: 'To clear', cleared: 'Ready to score', scored: 'Scored'
      }[s.status] || s.status;
    }
    const delayStr = s.delaySec ? `+${s.delaySec}s` : '—';
    return `<tr><td><b>${escHtml(s.group)}</b></td><td>${fmtMin(s.fixMinutes)}</td>
      <td>${delayStr}</td><td>${inAt}</td><td>${pullAt}</td><td>${actual}</td><td>${status}</td>
      <td style="width:100px;border-bottom:1px solid #000">&nbsp;</td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Fixation Log — ${escHtml(p.id)}</title>
<style>body{font-family:Arial,sans-serif;padding:24px;max-width:760px;margin:0 auto;color:#0f172a}
h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;font-weight:normal;color:#666;margin:0 0 16px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
th{text-align:left;border-bottom:2px solid #333;padding:6px 4px;font-size:11px;text-transform:uppercase}
td{border-bottom:1px solid #ddd;padding:8px 4px}
.info{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;font-size:13px}
.t0{background:#f0f0f0;padding:10px;margin:12px 0;border-radius:4px;font-size:14px;text-align:center}
.foot{margin-top:24px;font-size:11px;color:#666;text-align:center}
@media print{body{padding:12px}.no-print{display:none}}</style></head><body>
<h1>Fixation Log — Patient ${escHtml(p.id)}${p.name ? ' · ' + escHtml(p.name) : ''}</h1>
<h2>MK MSC Research App · Printed ${new Date().toLocaleString()}</h2>
<div class="info">
<div><b>Age:</b> ${p.age} years</div><div><b>Sex:</b> ${p.sex}</div>
<div><b>Smoking:</b> ${p.smoking}</div></div>
<div class="t0"><b>First slide into fixative (T₀):</b>
${p.t0 ? clockHHMM(p.t0) + ' · ' + new Date(p.t0).toLocaleDateString() : 'Not started'}</div>
<table><thead><tr><th>Group</th><th>Target</th><th>Delay</th><th>In at</th><th>Pull at</th><th>Actual</th><th>Status</th><th>Signature</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="foot"><p>Fixative: 95% ethyl alcohol · Stain: Papanicolaou</p>
<p>Sign each row when you remove that slide from fixative to the empty container.</p>
<p class="no-print"><button onclick="window.print()" style="padding:8px 16px;margin-top:8px;cursor:pointer">🖨 Print this page</button></p></div>
</body></html>`;

  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
  else toast('Pop-up blocked. Allow pop-ups to print fixation log.');
}

/* ===================== STATUS HELPERS ===================== */
function statusClass(s) {
  if (s.status === 'fixing' && Date.now() >= s.fixEnd) return 's-ready';
  return 's-' + s.status;
}
function statusLabel(s) {
  if (s.status === 'fixing' && Date.now() >= s.fixEnd) return 'READY';
  if (s.status === 'fixing') return fmt(s.fixEnd - Date.now());
  return {
    pending: '▶ Start', drying: 'container', staining: 'stain',
    stained: 'clear?', cleared: 'ready', scored: '✓'
  }[s.status] || s.status;
}

/* ===================== PATIENTS VIEW ===================== */
function patientMatchesFilter(p, filter) {
  if (filter === 'all') return true;
  const now = Date.now();
  return p.slides.some(s => {
    switch (filter) {
      case 'pending': return s.status === 'pending';
      case 'fixing': return s.status === 'fixing' && now < s.fixEnd;
      case 'ready': return s.status === 'fixing' && now >= s.fixEnd;
      case 'drying': return s.status === 'drying';
      case 'staining': return s.status === 'staining';
      case 'stained': return s.status === 'stained';
      case 'cleared': return s.status === 'cleared';
      case 'scored': return s.status === 'scored';
      default: return true;
    }
  });
}

function computeFilterCounts() {
  const now = Date.now();
  const counts = { all: state.patients.length };
  FILTERS.forEach(f => { if (f.id !== 'all') counts[f.id] = 0; });
  state.patients.forEach(p => {
    if (p.slides.some(s => s.status === 'pending')) counts.pending++;
    if (p.slides.some(s => s.status === 'fixing' && now < s.fixEnd)) counts.fixing++;
    if (p.slides.some(s => s.status === 'fixing' && now >= s.fixEnd)) counts.ready++;
    if (p.slides.some(s => s.status === 'drying')) counts.drying++;
    if (p.slides.some(s => s.status === 'staining')) counts.staining++;
    if (p.slides.some(s => s.status === 'stained')) counts.stained++;
    if (p.slides.some(s => s.status === 'cleared')) counts.cleared++;
    if (p.slides.some(s => s.status === 'scored')) counts.scored++;
  });
  return counts;
}

function renderFilterBar() {
  const counts = computeFilterCounts();
  const bar = $('filterBar');
  if (!bar) return;
  bar.innerHTML = FILTERS.map(f => {
    const active = patientFilter === f.id;
    const count = counts[f.id] || 0;
    const isEmpty = f.id !== 'all' && count === 0;
    return `<button class="filter-btn ${active ? 'active' : ''} ${isEmpty ? 'empty' : ''}"
                    data-filter="${f.id}"
                    onclick="setPatientFilter('${f.id}')"
                    ${isEmpty ? 'disabled' : ''}>
      ${f.label} <span class="filter-count">${count}</span>
    </button>`;
  }).join('');
}

function setPatientFilter(filter) { patientFilter = filter; renderPatients(); }
function setPatientSort(sort) { patientSort = sort; renderPatients(); }

function sortPatients(list) {
  return list.slice().sort((a, b) => {
    switch (patientSort) {
      case 'newest': return (b.createdAt || 0) - (a.createdAt || 0);
      case 'oldest': return (a.createdAt || 0) - (b.createdAt || 0);
      case 'id-asc': return a.id.localeCompare(b.id, undefined, { numeric: true });
      case 'id-desc': return b.id.localeCompare(a.id, undefined, { numeric: true });
      case 'name-asc': {
        const an = (a.name || '').trim(), bn = (b.name || '').trim();
        if (!an && !bn) return a.id.localeCompare(b.id, undefined, { numeric: true });
        if (!an) return 1; if (!bn) return -1;
        const cmp = an.localeCompare(bn, undefined, { sensitivity: 'base' });
        return cmp !== 0 ? cmp : a.id.localeCompare(b.id, undefined, { numeric: true });
      }
      case 'name-desc': {
        const an = (a.name || '').trim(), bn = (b.name || '').trim();
        if (!an && !bn) return b.id.localeCompare(a.id, undefined, { numeric: true });
        if (!an) return 1; if (!bn) return -1;
        const cmp = bn.localeCompare(an, undefined, { sensitivity: 'base' });
        return cmp !== 0 ? cmp : b.id.localeCompare(a.id, undefined, { numeric: true });
      }
      default: return (b.createdAt || 0) - (a.createdAt || 0);
    }
  });
}

function renderPatients() {
  renderFilterBar();

  const list = $('patientList');
  if (!list) return;
  if (!state.patients.length) {
    list.innerHTML = '<div class="card"><p class="muted" style="margin:0">No patients registered yet. Click <b>+ Register patient</b> to begin.</p></div>';
    return;
  }

  const q = ($('searchInput').value || '').trim().toLowerCase();
  const filtered = state.patients.filter(p => {
    if (!patientMatchesFilter(p, patientFilter)) return false;
    if (!q) return true;
    if (p.id.toLowerCase().includes(q)) return true;
    if ((p.name || '').toLowerCase().includes(q)) return true;
    if (p.slides.some(s => s.code.toLowerCase().includes(q))) return true;
    return false;
  });

  if (!filtered.length) {
    const filterName = (FILTERS.find(f => f.id === patientFilter) || {}).label || 'filter';
    list.innerHTML = `<div class="card"><p class="muted" style="margin:0">No patients match <b>${filterName}</b>${q ? ' + search "' + escHtml(q) + '"' : ''}.</p></div>`;
    return;
  }

  const sorted = sortPatients(filtered);

  list.innerHTML = sorted.map(p => {
    const hasReady = p.slides.some(s => s.status === 'fixing' && Date.now() >= s.fixEnd);
    const hasActive = p.slides.some(s => s.status === 'fixing');
    const cardClass = (hasReady ? 'has-ready' : (hasActive ? 'has-active' : '')) + (p.simulated ? ' simulated' : '');

    const counts = {
      fixing: p.slides.filter(s => s.status === 'fixing' && Date.now() < s.fixEnd).length,
      ready: p.slides.filter(s => s.status === 'fixing' && Date.now() >= s.fixEnd).length,
      drying: p.slides.filter(s => s.status === 'drying').length,
      stained: p.slides.filter(s => s.status === 'stained').length,
      cleared: p.slides.filter(s => s.status === 'cleared').length,
      scored: p.slides.filter(s => s.status === 'scored').length,
      pending: p.slides.filter(s => s.status === 'pending').length
    };
    const summaryParts = [];
    if (counts.pending) summaryParts.push(`${counts.pending} pending`);
    if (counts.fixing) summaryParts.push(`${counts.fixing} fixing`);
    if (counts.ready) summaryParts.push(`<b style="color:#dc2626">${counts.ready} ready</b>`);
    if (counts.drying) summaryParts.push(`${counts.drying} container`);
    if (counts.stained) summaryParts.push(`${counts.stained} to clear`);
    if (counts.cleared) summaryParts.push(`${counts.cleared} to score`);
    if (counts.scored) summaryParts.push(`${counts.scored} scored`);

    const isOpen = expandedPatients.has(p.id);

    const chips = p.slides.map(s => {
      const isPending = s.status === 'pending';
      const isReady = s.status === 'fixing' && Date.now() >= s.fixEnd;
      const isFixing = s.status === 'fixing' && !isReady;
      const clickable = isPending || isReady;
      const onclick = isPending ? `onclick="startSlide('${s.code}')"` : (isReady ? `onclick="removeSlide('${s.code}')"` : '');
      const clock = isPending ? '' : clockHHMM(s.fixEnd);
      const chipClass = 'slide-chip ' + statusClass(s) + (clickable ? ' clickable' : '');
      return `
      <div class="${chipClass}" data-code="${s.code}" ${onclick} style="${clickable ? 'cursor:pointer' : ''}">
        <span class="grp">${escHtml(s.group)}</span>
        <span class="chip-time" data-code="${s.code}">${statusLabel(s)}</span>
        ${clock ? `<span class="chip-clock">${clock}</span>` : ''}
      </div>`;
    }).join('');

    const detailRows = p.slides.map(s => {
      const action = s.status === 'pending'
        ? `<button class="btn sm" style="font-size:.72rem" onclick="event.stopPropagation();startSlide('${s.code}')">▶ Start</button>`
        : s.status === 'fixing'
          ? `<button class="btn sm" style="font-size:.72rem" onclick="event.stopPropagation();removeSlide('${s.code}')">Take to Empty Container</button>`
          : `<span class="muted">—</span>`;
      const inAt = s.fixStart ? clockHHMM(s.fixStart) : '—';
      return `<tr>
        <td><b>${escHtml(s.group)}</b></td>
        <td>${fmtMin(s.fixMinutes)}</td>
        <td>${s.delaySec ? '+' + s.delaySec + 's' : '—'}</td>
        <td>${inAt}</td>
        <td class="cd" data-code="${s.code}">—</td>
        <td><b>${s.status === 'pending' ? '—' : clockHHMM(s.fixEnd)}</b></td>
        <td>${s.actualMinutes != null ? s.actualMinutes.toFixed(2) + ' min' : '—'}</td>
        <td>${s.status}</td>
        <td>${action}</td>
      </tr>`;
    }).join('');

    return `<div class="patient-card ${cardClass}" data-pid="${p.id}">
      <div class="patient-header">
        <div>
          <span class="patient-id">${p.id}</span>${p.simulated ? '<span class="sim-badge">SIM</span>' : ''}
          ${p.name ? `<span class="patient-name">${escHtml(p.name)}</span>` : ''}
          <div class="patient-meta">Age ${p.age} · ${p.sex} · Smoking: ${p.smoking}</div>
          ${p.notes ? `<div class="patient-notes">📝 ${escHtml(p.notes)}</div>` : ''}
        </div>
        <div class="patient-status">
          <div class="patient-summary">${summaryParts.join(' · ') || 'Registered'}</div>
          <div class="muted">${p.t0 ? 'T₀ ' + timeAt(p.t0) : 'Not started'}</div>
        </div>
      </div>
      <div class="slide-chips">${chips}</div>
      ${p.slides.some(s => s.status === 'pending') ? `<div class="row" style="margin-top:4px">
        <button class="btn" onclick="startAllPending('${p.id}')">▶ Start all pending slides</button>
        ${!p.t0 ? `<button class="btn ghost sm" onclick="deletePatient('${p.id}')">🗑 Delete</button>` : ''}
      </div>
      <p class="muted" style="font-size:.72rem;margin:6px 0 0">💡 For precise timing, click each slide chip above as you put it in fixative.</p>` : ''}
      <button class="expand-btn" onclick="toggleExpandPatient('${p.id}')">
        ${isOpen ? '▲ Hide details' : '▼ Show details'}
      </button>
      ${isOpen ? `<div class="patient-details">
        <table class="tbl">
          <thead><tr><th>Grp</th><th>Target</th><th>Delay</th><th>In at</th><th>Remaining</th><th>Pull at</th><th>Actual</th><th>Status</th><th></th></tr></thead>
          <tbody>${detailRows}</tbody>
        </table>
        <div class="row" style="margin-top:8px">
          ${p.t0 ? `<button class="btn ghost sm" onclick="printFixationLog('${p.id}')">🖨 Print fixation log</button>` : ''}
          ${p.t0 ? `<button class="btn ghost sm" onclick="deletePatient('${p.id}')">🗑 Delete patient</button>` : ''}
        </div>
      </div>` : ''}
    </div>`;
  }).join('');

  updateClocks();
}

function removeSlide(code) {
  const s = findSlide(code);
  if (!s || s.status !== 'fixing') return;
  const rem = s.fixEnd - Date.now();
  if (rem > 1500) {
    if (!confirm(`${code}: ${fmt(rem)} of fixation remaining.\n\nTake to empty container early anyway?`)) return;
  }
  s.fixEndActual = Date.now();
  s.actualMinutes = (s.fixEndActual - s.fixStart) / 60000;
  s.status = 'drying';
  save();
  beep(1);
  toast(`${code} → empty container — actual fixation ${s.actualMinutes.toFixed(2)} min`);
  renderAll();
}

/* ===================== FIXATION TAB ===================== */
function renderNextPullBanner() {
  const el = $('nextPullBanner');
  if (!el) return;

  const fixing = allSlides().filter(x => x.s.status === 'fixing');
  if (!fixing.length) {
    el.innerHTML = `<div class="next-pull-banner idle">
      <div>
        <div class="next-pull-label">Next pull</div>
        <div class="next-pull-main">Nothing in fixation</div>
        <div class="next-pull-time">Start slides in Fixation tab to see pull times</div>
      </div>
    </div>`;
    return;
  }

  const now = Date.now();
  const withTime = fixing.map(x => ({ ...x, rem: x.s.fixEnd - now }));
  withTime.sort((a, b) => a.rem - b.rem);
  const next = withTime[0];

  const isDue = next.rem <= 0;
  const cls = isDue ? 'urgent' : '';
  const nextTime = clockHHMM(next.s.fixEnd);
  const countdown = isDue ? 'Pull now!' : 'In ' + fmt(next.rem);

  el.innerHTML = `<div class="next-pull-banner ${cls}">
    <div>
      <div class="next-pull-label">${isDue ? '⚡ OVERDUE — Pull now' : 'Next pull'}</div>
      <div class="next-pull-main">${next.p.id} · Group ${escHtml(next.s.group)} (${fmtMin(next.s.fixMinutes)})</div>
      <div class="next-pull-time">Scheduled: ${nextTime} · ${countdown}</div>
    </div>
    ${isDue ? `<button class="btn" style="background:#fff;color:#dc2626" onclick="removeSlide('${next.s.code}')">✓ Pull now</button>` : ''}
  </div>`;
}

function renderTodaySchedule() {
  const el = $('todaySchedule');
  const summary = $('scheduleSummary');
  if (!el) return;

  const now = Date.now();
  const pending = allSlides().filter(x => x.s.status === 'fixing');
  if (!pending.length) {
    el.innerHTML = '<p class="muted" style="margin:0">No pending pulls. All slides are pulled or awaiting start.</p>';
    if (summary) summary.textContent = '';
    return;
  }

  const sorted = pending.map(x => ({ ...x, rem: x.s.fixEnd - now })).sort((a, b) => a.s.fixEnd - b.s.fixEnd);
  const dueCount = sorted.filter(x => x.rem <= 0).length;

  if (summary) {
    summary.textContent = dueCount > 0
      ? `${sorted.length} total · ${dueCount} overdue`
      : `${sorted.length} upcoming`;
  }

  let html = `<div class="schedule-row header">
    <div>Time</div><div>Slide</div><div>Patient</div><div>Fixation</div><div>Status</div>
  </div>`;

  sorted.forEach(({ p, s, rem }) => {
    const isDue = rem <= 0;
    const rowClass = isDue ? 'due' : 'upcoming';
    const timeStr = clockHHMM(s.fixEnd);
    let badge, badgeClass;
    if (isDue) {
      badge = 'Pull now (+' + fmt(-rem) + ')';
      badgeClass = 'due';
    } else if (rem < 3600000) {
      badge = 'in ' + fmt(rem);
      badgeClass = 'in-min';
    } else {
      badge = 'in ' + fmt(rem);
      badgeClass = 'in-hr';
    }

    html += `<div class="schedule-row ${rowClass}">
      <div class="sched-time">${timeStr}</div>
      <div><b>${s.code}</b></div>
      <div>${p.id}</div>
      <div>${fmtMin(s.fixMinutes)}</div>
      <div><span class="sched-badge ${badgeClass}">${badge}</span></div>
    </div>`;
  });

  el.innerHTML = html;
}

function renderFixationTab() {
  renderNextPullBanner();
  renderTodaySchedule();

  const activeEl = $('fixationActive');
  if (!activeEl) return;
  const activePats = state.patients.filter(p => p.slides.some(s => s.status === 'fixing' || s.status === 'pending'));

  if (!activePats.length) {
    activeEl.innerHTML = '<p class="muted" style="margin:0">No patients in fixation. Register a patient in Reception first.</p>';
  } else {
    activeEl.innerHTML = activePats.map(p => {
      const ready = p.slides.filter(s => s.status === 'fixing' && Date.now() >= s.fixEnd).length;
      const pendingCount = p.slides.filter(s => s.status === 'pending').length;
      const chips = p.slides.map(s => {
        if (s.status !== 'fixing' && s.status !== 'pending') return '';
        const isPending = s.status === 'pending';
        const isReady = s.status === 'fixing' && Date.now() >= s.fixEnd;
        const clickable = isPending || isReady;
        const onclick = isPending ? `onclick="startSlide('${s.code}')"` : (isReady ? `onclick="removeSlide('${s.code}')"` : '');
        const cls = isPending ? 's-pending' : (isReady ? 's-ready' : 's-fixing');
        const clock = isPending ? '' : clockHHMM(s.fixEnd);
        return `<button class="slide-chip ${cls}${clickable ? ' clickable' : ''}" data-code="${s.code}" ${onclick} style="cursor:${clickable ? 'pointer' : 'default'}">
          <span class="grp">${escHtml(s.group)}</span>
          <span class="chip-time" data-code="${s.code}">${statusLabel(s)}</span>
          ${clock ? `<span class="chip-clock">${clock}</span>` : ''}
        </button>`;
      }).join('');
      return `<div class="patient-card" data-pid="${p.id}">
        <div class="patient-header" style="margin-bottom:8px">
          <div>
            <span class="patient-id">${p.id}</span>
            ${p.name ? `<span class="patient-name">${escHtml(p.name)}</span>` : ''}
            <div class="patient-meta">${p.t0 ? 'T₀ ' + timeAt(p.t0) : 'Not started'}${ready ? ` · <b style="color:#dc2626">${ready} ready</b>` : ''}${pendingCount ? ` · <b style="color:#64748b">${pendingCount} pending</b>` : ''}</div>
          </div>
          ${pendingCount ? `<button class="btn ghost sm" onclick="startAllPending('${p.id}')">▶ Start all pending</button>` : ''}
        </div>
        <div class="slide-chips">${chips}</div>
      </div>`;
    }).join('');
  }

  const containerEl = $('fixationContainer');
  if (!containerEl) return;
  const containerPats = state.patients
    .map(p => ({ p, drying: p.slides.filter(s => s.status === 'drying') }))
    .filter(x => x.drying.length > 0);

  if (!containerPats.length) {
    containerEl.innerHTML = '<p class="muted" style="margin:0">Empty container is empty. Remove slides from fixation to fill it.</p>';
  } else {
    const totalDrying = containerPats.reduce((a, x) => a + x.drying.length, 0);
    containerEl.innerHTML = `<p class="muted" style="margin-top:0"><b>${totalDrying}</b> slide${totalDrying > 1 ? 's' : ''} across <b>${containerPats.length}</b> patient${containerPats.length > 1 ? 's' : ''}</p>` +
      containerPats.map(({ p, drying }) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;
                    background:#f8fafc;border:1px solid var(--line);border-radius:8px;margin-bottom:6px">
          <span><b>${p.id}</b>${p.name ? ' · ' + escHtml(p.name) : ''}</span>
          <span class="chips" style="margin:0">
            ${drying.map(s => `<span class="chipbtn" style="cursor:default">${escHtml(s.group)}</span>`).join('')}
          </span>
        </div>`).join('');
  }

  const fixing = allSlides().filter(x => x.s.status === 'fixing').length;
  const ready = allSlides().filter(x => x.s.status === 'fixing' && Date.now() >= x.s.fixEnd).length;
  const summary = $('fixationSummary');
  if (summary) summary.textContent = `${fixing} fixing${ready ? ` · ${ready} ready` : ''}`;

  updateClocks();
}

/* ===================== STAINING ===================== */
function toggleSel(code) {
  if (selected.has(code)) selected.delete(code); else selected.add(code);
  renderStaining();
}
function togglePatientSel(pid) {
  const p = state.patients.find(x => x.id === pid);
  if (!p) return;
  const codes = p.slides.filter(s => s.status === 'drying').map(s => s.code);
  const allIn = codes.every(c => selected.has(c));
  codes.forEach(c => allIn ? selected.delete(c) : selected.add(c));
  renderStaining();
}
function clearSel() { selected.clear(); renderStaining(); }

function renderStaining() {
  const wrap = $('stainSelect');
  if (!wrap) return;
  const avail = allSlides().filter(x => x.s.status === 'drying');

  if (!avail.length) {
    wrap.innerHTML = '<p class="muted" style="margin:0">No slides in empty container. Take slides from fixation to empty container first.</p>';
  } else {
    const byPatient = {};
    avail.forEach(({ p, s }) => { (byPatient[p.id] = byPatient[p.id] || []).push(s); });

    wrap.innerHTML = Object.keys(byPatient).map(pid => {
      const p = state.patients.find(x => x.id === pid);
      const chips = byPatient[pid].map(s =>
        `<button class="chipbtn ${selected.has(s.code) ? 'sel' : ''}" onclick="toggleSel('${s.code}')">${s.code}</button>`
      ).join('');
      const codes = byPatient[pid].map(s => s.code);
      const allIn = codes.every(c => selected.has(c));
      return `<div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:.85rem">
          <span><b>${p.id}</b>${p.name ? ' <span class="muted">' + escHtml(p.name) + '</span>' : ''}${p.simulated ? ' <span class="sim-badge">SIM</span>' : ''}</span>
          <a href="#" onclick="togglePatientSel('${pid}');return false;" style="color:var(--accent2);font-size:.75rem">
            ${allIn ? 'unselect all' : 'select all'}
          </a>
        </div>
        <div class="chips">${chips}</div>
      </div>`;
    }).join('');
  }

  if ($('selCount')) $('selCount').textContent = selected.size;
  if ($('btnStartBatch')) $('btnStartBatch').disabled = selected.size === 0;

  const pc = $('protocolStepCount');
  if (pc) pc.textContent = '· ' + state.protocol.length + ' step' + (state.protocol.length === 1 ? '' : 's');

  renderBatches();
}

function startBatch() {
  if (!selected.size) return;
  state.seqBatch++;
  const id = 'B' + String(state.seqBatch).padStart(2, '0');
  const now = Date.now();
  const codes = Array.from(selected);

  codes.forEach(c => {
    const s = findSlide(c);
    if (s) s.status = 'staining';
  });

  state.batches.push({
    id, slides: codes,
    stepIndex: 0,
    stepStart: null,
    stepEnd: null,
    stepRunning: false,
    startedAt: now,
    completedAt: null,
    status: 'running',
    notified: false,
    protocolSnapshot: deepCopyProtocol(state.protocol),
    protocolVersion: state.protocolVersion,
    stepLog: []
  });

  selected.clear();
  save();
  beep(1);
  toast(`Batch ${id} started (protocol v${state.protocolVersion}) — click ▶ Start step`);
  renderAll();
}

function startStep(id) {
  const b = findBatch(id);
  if (!b || b.status !== 'running' || b.stepRunning) return;
  const proto = batchProtocol(b);
  const step = proto[b.stepIndex];
  if (!step || step.sec <= 0) return;
  b.stepStart = Date.now();
  b.stepEnd = b.stepStart + step.sec * 1000;
  b.stepRunning = true;
  b.notified = false;
  b.stepLog.push({
    stepNum: b.stepIndex + 1,
    stepName: step.name,
    plannedSec: step.sec,
    startTime: b.stepStart,
    endTime: null,
    actualSec: null
  });
  save(); beep(1);
  toast(`Batch ${b.id} — timing "${step.name}" (${fmtStepDuration(step.sec)})`);
  renderAll();
}

function finalizeCurrentStepLog(b) {
  if (!b.stepRunning || !b.stepLog || !b.stepLog.length) return;
  const last = b.stepLog[b.stepLog.length - 1];
  if (last.endTime === null) {
    last.endTime = Date.now();
    last.actualSec = Math.round((last.endTime - last.startTime) / 1000);
  }
}

function nextStep(id) {
  const b = findBatch(id);
  if (!b || b.status !== 'running') return;
  const proto = batchProtocol(b);
  if (b.stepIndex >= proto.length - 1) { completeBatch(id); return; }
  finalizeCurrentStepLog(b);
  b.stepIndex++;
  b.stepStart = null;
  b.stepEnd = null;
  b.stepRunning = false;
  b.notified = false;
  save();
  renderAll();
}

function completeBatch(id) {
  const b = findBatch(id);
  if (!b) return;
  finalizeCurrentStepLog(b);
  b.status = 'done';
  b.completedAt = Date.now();
  b.stepRunning = false;
  b.slides.forEach(c => {
    const s = findSlide(c);
    if (s) s.status = 'stained';
  });
  save(); beep(2);
  toast(`Batch ${b.id} completed — slides ready for clear & mount confirmation`);
  renderAll();
}

function abortBatch(id) {
  const b = findBatch(id);
  if (!b) return;
  if (!confirm(`Abort batch ${b.id}? Slides return to empty container.`)) return;
  finalizeCurrentStepLog(b);
  if (b.stepLog.length > 0) b.stepLog[b.stepLog.length - 1].incomplete = true;
  b.status = 'aborted';
  b.completedAt = Date.now();
  b.stepRunning = false;
  b.slides.forEach(c => {
    const s = findSlide(c);
    if (s) s.status = 'drying';
  });
  save();
  renderAll();
}

function renderBatches() {
  const active = state.batches.filter(b => b.status === 'running');
  const el = $('activeBatches');
  if (!el) return;

  if (!active.length) {
    el.innerHTML = '<p class="muted" style="margin:0">No batch running. Select slides above and click <b>Start batch</b>.</p>';
  } else {
    el.innerHTML = active.map(b => {
      const proto = batchProtocol(b);
      const step = proto[b.stepIndex] || { name: '(no step)', sec: 0 };
      const isLast = b.stepIndex >= proto.length - 1;
      const isTiming = b.stepRunning && step.sec > 0;
      const timerDone = isTiming && b.stepEnd && Date.now() >= b.stepEnd;
      const versionMismatch = (b.protocolVersion || 1) !== state.protocolVersion;

      let btns = '';
      if (isLast) {
        btns = `<button class="btn" onclick="completeBatch('${b.id}')">✓ Complete batch</button>`;
      } else if (!b.stepRunning) {
        btns = `<button class="btn" onclick="startStep('${b.id}')">▶ Start step</button>
                <button class="btn ghost" onclick="nextStep('${b.id}')">Skip →</button>`;
      } else {
        btns = `<button class="btn" onclick="nextStep('${b.id}')">${timerDone ? 'Next step →' : 'Skip to next step →'}</button>`;
      }

      const timerDisplay = !b.stepRunning
        ? '<div class="bigtime idle">Not started</div>'
        : `<div class="bigtime batchcd ${timerDone ? 'ready' : ''}" data-batch="${b.id}">—</div>`;

      const stepList = proto.map((st, i) => {
        const cls = i < b.stepIndex ? 'done' : (i === b.stepIndex ? 'current' : '');
        const label = `${escHtml(st.name)}${st.sec > 0 ? ' (' + fmtStepDuration(st.sec) + ')' : ''}`;
        return `<li class="${cls}">${label}</li>`;
      }).join('');

      return `<div class="card" style="margin-bottom:10px">
        <div class="card-head">
          <div><span class="step-badge">${b.id}</span><b>${b.slides.length} slides</b>
            <span class="muted" style="font-size:.7rem">· protocol v${b.protocolVersion || 1}${versionMismatch ? ' (frozen)' : ''}</span>
          </div>
          <div class="muted">Started ${timeAt(b.startedAt)}</div>
        </div>
        <div class="stepnow">
          Step ${b.stepIndex + 1} of ${proto.length} — ${escHtml(step.name)}
          ${step.sec > 0 ? `<span class="muted"> · ${fmtStepDuration(step.sec)}</span>` : ''}
        </div>
        ${timerDisplay}
        <div class="bar"><div class="barfill" data-bar="${b.id}" style="width:0%"></div></div>
        <div class="row">
          ${btns}
          <button class="btn ghost" onclick="abortBatch('${b.id}')">Abort</button>
        </div>
        <div class="steplist">
          <details ${expandedProtocols.has(b.id) ? 'open' : ''}>
            <summary onclick="toggleProtocolExpand('${b.id}')">View full protocol (v${b.protocolVersion || 1})</summary>
            <ol>${stepList}</ol>
          </details>
        </div>
        <details ${expandedSlideLists.has(b.id) ? 'open' : ''} style="margin-top:10px">
          <summary class="muted" style="cursor:pointer" onclick="toggleSlideListExpand('${b.id}')">Slides in this batch (${b.slides.length})</summary>
          <div class="chips">${b.slides.map(c => `<span class="chipbtn">${c}</span>`).join('')}</div>
        </details>
      </div>`;
    }).join('');
  }

  const done = state.batches.filter(b => b.status !== 'running').slice().reverse();
  const historyEl = $('batchHistory');
  if (historyEl) {
    historyEl.innerHTML = done.length
      ? `<table class="tbl"><thead><tr><th>Batch</th><th>Slides</th><th>Protocol</th><th>Status</th><th>Completed</th></tr></thead><tbody>
          ${done.map(b => `<tr>
            <td><b>${b.id}</b></td>
            <td>${b.slides.length}</td>
            <td>v${b.protocolVersion || 1}</td>
            <td>${b.status === 'done' ? '✅ Done' : '⛔ Aborted'}</td>
            <td>${b.completedAt ? timeAt(b.completedAt) : '—'}</td>
          </tr>`).join('')}
        </tbody></table>`
      : '<p class="muted" style="margin:0">No completed batches yet.</p>';
  }

  updateClocks();
}

/* ===================== CLEAR & MOUNT ===================== */
function renderClearMountTab() {
  const el = $('clearMountList');
  if (!el) return;
  const stainedSlides = allSlides().filter(x => x.s.status === 'stained');

  if (!stainedSlides.length) {
    el.innerHTML = '<p class="muted" style="margin:0">No slides awaiting clear & mount confirmation. Complete a staining batch to populate this list.</p>';
    return;
  }

  const byBatch = {};
  stainedSlides.forEach(({ p, s }) => {
    const batch = state.batches.find(b => b.slides.includes(s.code));
    const bid = batch ? batch.id : 'unknown';
    if (!byBatch[bid]) byBatch[bid] = { batch, slides: [] };
    byBatch[bid].slides.push({ p, s });
  });

  el.innerHTML = Object.keys(byBatch).map(bid => {
    const { batch, slides } = byBatch[bid];
    const batchInfo = batch ? ` · completed ${timeAt(batch.completedAt)}` : '';
    return `<div class="patient-card" style="margin-bottom:12px">
      <div class="patient-header" style="margin-bottom:10px">
        <div>
          <span class="patient-id">${bid}</span>
          <div class="patient-meta">${slides.length} slide${slides.length > 1 ? 's' : ''} awaiting confirmation${batchInfo}</div>
        </div>
        <button class="btn" onclick="confirmBatchCleared('${bid}')">✓ Confirm all cleared & mounted</button>
      </div>
      <table class="tbl">
        <thead><tr><th>Slide</th><th>Patient</th><th>Group</th><th>Fixation</th><th></th></tr></thead>
        <tbody>
          ${slides.map(({ p, s }) => `<tr>
            <td><b>${s.code}</b></td>
            <td>${p.id}${p.name ? ' · ' + escHtml(p.name) : ''}</td>
            <td>${escHtml(s.group)}</td>
            <td>${fmtMin(s.fixMinutes)}</td>
            <td><button class="btn ghost sm" onclick="confirmSlideCleared('${s.code}')">✓ Confirm</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }).join('');
}

function confirmSlideCleared(code) {
  const s = findSlide(code);
  if (!s || s.status !== 'stained') return;
  s.status = 'cleared';
  save();
  beep(1);
  toast(`${code} — clear & mount confirmed, ready for scoring`);
  renderAll();
}

function confirmBatchCleared(bid) {
  const batch = findBatch(bid);
  if (!batch) return;
  const stained = batch.slides.map(findSlide).filter(s => s && s.status === 'stained');
  if (!stained.length) { toast('No slides to confirm in this batch'); return; }
  if (!confirm(`Mark ${stained.length} slide${stained.length > 1 ? 's' : ''} in batch ${bid} as cleared & mounted?`)) return;
  stained.forEach(s => { s.status = 'cleared'; });
  save();
  beep(2);
  toast(`${stained.length} slide${stained.length > 1 ? 's' : ''} marked ready for scoring`);
  renderAll();
}

/* ===================== SCORING ===================== */
function scoreOf(s) {
  if (!s.scores || !s.scores.o1 || !s.scores.o2) return null;
  const o1 = s.scores.o1, o2 = s.scores.o2;
  for (const par of PARAMS) {
    if (typeof o1[par.k] !== 'number' || typeof o2[par.k] !== 'number') return null;
  }
  const t1 = PARAMS.reduce((a, par) => a + o1[par.k], 0);
  const t2 = PARAMS.reduce((a, par) => a + o2[par.k], 0);
  return { o1, o2, t1, t2, c1: classify(t1), c2: classify(t2) };
}

function renderScoreSummary() {
  const scored = allSlides().filter(x => x.s.status === 'scored' && scoreOf(x.s));
  if (!scored.length) return '';

  const groups = getGroups();
  const rows = groups.map(g => {
    const gs = scored.filter(x => x.s.group === g.id);
    if (!gs.length) return `<tr><td><b>${escHtml(g.id)}</b></td><td>${fmtMin(g.minutes)}</td><td>0</td><td colspan="5" class="muted">No data yet</td></tr>`;

    const t1s = gs.map(x => scoreOf(x.s).t1);
    const t2s = gs.map(x => scoreOf(x.s).t2);
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

    const cnt = { Optimal: 0, Satisfactory: 0, Poor: 0, 'Non-diagnostic': 0 };
    t1s.forEach(t => cnt[classify(t)]++);

    return `<tr>
      <td><b>${escHtml(g.id)}</b></td>
      <td>${fmtMin(g.minutes)}</td>
      <td>${gs.length}</td>
      <td>${mean(t1s).toFixed(1)} ± ${sd(t1s).toFixed(1)}</td>
      <td>${mean(t2s).toFixed(1)} ± ${sd(t2s).toFixed(1)}</td>
      <td>${cnt.Optimal}</td>
      <td>${cnt.Satisfactory}</td>
      <td>${cnt.Poor + cnt['Non-diagnostic']}</td>
    </tr>`;
  }).join('');

  return `<div class="card">
    <h2>📈 Group summary (preliminary)</h2>
    <p class="muted" style="margin-top:0">Live summary across scored slides. Classes based on Observer 1. <b>Use SPSS for formal analysis.</b></p>
    <table class="tbl">
      <thead><tr>
        <th>Group</th><th>Fixation</th><th>n scored</th>
        <th>Obs 1 mean ± SD</th><th>Obs 2 mean ± SD</th>
        <th>Optimal</th><th>Satisfactory</th><th>Poor / ND</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderScoring() {
  const summaryEl = $('scoreSummary');
  if (summaryEl) summaryEl.innerHTML = renderScoreSummary();

  const list = allSlides().filter(x => x.s.status === 'cleared' || x.s.status === 'scored');
  const el = $('scoreList');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = '<div class="card"><p class="muted" style="margin:0">No slides ready for scoring yet. Confirm clear & mount first.</p></div>';
    return;
  }

  const byPatient = {};
  list.forEach(({ p, s }) => { (byPatient[p.id] = byPatient[p.id] || []).push(s); });

  el.innerHTML = Object.keys(byPatient).map(pid => {
    const p = state.patients.find(x => x.id === pid);
    const scoredCount = byPatient[pid].filter(s => s.status === 'scored').length;
    const rows = byPatient[pid].sort((a, b) => String(a.group).localeCompare(String(b.group))).map(s => {
      const sc = scoreOf(s);
      const o1Cell = sc ? `${sc.t1}/15 <span class="muted">${escHtml(sc.c1)}</span>` : '—';
      const o2Cell = sc ? `${sc.t2}/15 <span class="muted">${escHtml(sc.c2)}</span>` : '—';
      return `<tr>
        <td><b>${s.code}</b></td>
        <td>${fmtMin(s.fixMinutes)}</td>
        <td>${s.actualMinutes != null ? s.actualMinutes.toFixed(1) + ' min' : '—'}</td>
        <td>${o1Cell}</td>
        <td>${o2Cell}</td>
        <td><button class="btn sm ${sc ? 'ghost' : ''}" onclick="openScore('${s.code}')">${sc ? 'Edit' : 'Score'}</button></td>
      </tr>`;
    }).join('');

    return `<div class="card">
      <div class="card-head">
        <div><b>${p.id}</b>${p.simulated ? ' <span class="sim-badge">SIM</span>' : ''}${p.name ? ' · ' + escHtml(p.name) : ''}</div>
        <div class="muted">${scoredCount} / ${byPatient[pid].length} scored</div>
      </div>
      <table class="tbl">
        <thead><tr><th>Slide</th><th>Fixation</th><th>Actual</th><th>Obs 1</th><th>Obs 2</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');
}

function countFilled(obs) {
  const map = tempScores[obs] || {};
  let filled = 0;
  PARAMS.forEach(par => { if (typeof map[par.k] === 'number') filled++; });
  return filled;
}

function openScore(code) {
  const s = findSlide(code);
  const p = patientOf(code);
  if (!s || !p) return;

  $('modalTitle').textContent = 'Score ' + code;

  tempScores = { o1: {}, o2: {} };
  if (s.scores) {
    PARAMS.forEach(par => {
      if (s.scores.o1 && typeof s.scores.o1[par.k] === 'number') tempScores.o1[par.k] = s.scores.o1[par.k];
      if (s.scores.o2 && typeof s.scores.o2[par.k] === 'number') tempScores.o2[par.k] = s.scores.o2[par.k];
    });
  }

  const col = (obs) => {
    const pref = obs === 1 ? 'o1' : 'o2';
    const filled = countFilled(pref);
    const colClass = filled === PARAMS.length ? 'complete' : (filled > 0 ? 'incomplete' : '');
    return `
    <div class="col ${colClass}">
      <h4>Observer ${obs} <span class="muted" style="font-size:.72rem;font-weight:500" id="ob${obs}prog">${filled}/${PARAMS.length} filled</span></h4>
      ${PARAMS.map(par => {
      const cur = tempScores[pref][par.k];
      return `
        <label>${par.label}</label>
        <div class="score-btns">
          ${[0, 1, 2, 3].map(v => `
            <button type="button"
                    class="score-btn ${cur === v ? 'sel' : ''}"
                    data-obs="${pref}"
                    data-param="${par.k}"
                    data-val="${v}"
                    onclick="pickScore(this)">${v}</button>
          `).join('')}
        </div>`;
    }).join('')}
      <div class="total" id="${obs === 1 ? 't1' : 't2'}">– / 15</div>
    </div>`;
  };

  $('modalBody').innerHTML = `
    <div class="warnbox">
      <b>${p.id}</b>${p.name ? ' · ' + escHtml(p.name) : ''} · Age ${p.age} · ${p.sex} · Smoking: ${p.smoking}<br>
      Group <b>${escHtml(s.group)}</b> · Target ${fmtMin(s.fixMinutes)} · Actual ${s.actualMinutes != null ? s.actualMinutes.toFixed(2) + ' min' : '—'}
    </div>
    <div class="scoregrid">
      ${col(1)}
      ${col(2)}
    </div>
    <div class="row">
      <button class="btn" id="saveScoreBtn" onclick="saveScore('${code}')">Save scores</button>
      <button class="btn ghost" onclick="closeModal('modal-score')">Cancel</button>
    </div>`;
  $('modal-score').classList.remove('hidden');
  updateTotals();
}

function pickScore(btn) {
  const obs = btn.dataset.obs;
  const param = btn.dataset.param;
  const val = parseInt(btn.dataset.val, 10);

  const group = btn.parentElement;
  group.querySelectorAll('.score-btn').forEach(b => b.classList.remove('sel'));
  btn.classList.add('sel');

  if (!tempScores[obs]) tempScores[obs] = {};
  tempScores[obs][param] = val;
  updateTotals();
}

function updateTotals() {
  [1, 2].forEach(obs => {
    const pref = obs === 1 ? 'o1' : 'o2';
    const box = $('t' + obs);
    const prog = $('ob' + obs + 'prog');
    const col = box ? box.closest('.col') : null;
    if (!box) return;

    let total = 0, filled = 0;
    PARAMS.forEach(par => {
      const v = tempScores[pref] ? tempScores[pref][par.k] : undefined;
      if (typeof v === 'number') { total += v; filled++; }
    });

    const complete = filled === PARAMS.length;
    box.textContent = complete ? `${total} / 15 — ${classify(total)}` : `${filled}/${PARAMS.length} filled — ${total} so far`;

    if (prog) prog.textContent = `${filled}/${PARAMS.length} filled`;

    if (col) {
      col.classList.toggle('complete', complete);
      col.classList.toggle('incomplete', !complete && filled > 0);
    }
  });
}

function saveScore(code) {
  const s = findSlide(code);
  if (!s) return;

  const missing = [];
  for (const obs of ['o1', 'o2']) {
    for (const par of PARAMS) {
      const v = tempScores[obs] ? tempScores[obs][par.k] : undefined;
      if (typeof v !== 'number') {
        missing.push(`${obs === 'o1' ? 'Obs 1' : 'Obs 2'} · ${par.label}`);
      }
    }
  }

  if (missing.length > 0) {
    const o1Missing = missing.filter(m => m.startsWith('Obs 1')).length;
    const o2Missing = missing.filter(m => m.startsWith('Obs 2')).length;
    let detail = '';
    if (o1Missing && o2Missing) detail = `Observer 1 missing ${o1Missing} param${o1Missing > 1 ? 's' : ''}, Observer 2 missing ${o2Missing}`;
    else if (o1Missing) detail = `Observer 1 missing ${o1Missing} param${o1Missing > 1 ? 's' : ''}`;
    else detail = `Observer 2 missing ${o2Missing} param${o2Missing > 1 ? 's' : ''}`;
    toast(`Cannot save — ${detail}`);
    return;
  }

  const sc = { o1: {}, o2: {} };
  for (const obs of ['o1', 'o2']) {
    for (const par of PARAMS) {
      sc[obs][par.k] = tempScores[obs][par.k];
    }
  }

  s.scores = sc;
  s.status = 'scored';
  save();
  closeModal('modal-score');
  renderAll();
  toast(`${code} scored and saved`);
}

/* ===================== TIMING REPORT ===================== */
function renderTimingTab() {
  renderTimingOverview();
  renderTimingPatients();
}

function renderTimingOverview() {
  const el = $('timingOverview');
  if (!el) return;

  const all = allSlides();
  const stats = {
    total: all.length,
    pending: all.filter(x => x.s.status === 'pending').length,
    fixing: all.filter(x => x.s.status === 'fixing').length,
    drying: all.filter(x => x.s.status === 'drying').length,
    staining: all.filter(x => x.s.status === 'staining').length,
    done: all.filter(x => ['stained', 'cleared', 'scored'].includes(x.s.status)).length
  };

  const groups = getGroups();
  const groupStats = groups.map(g => {
    const slides = all.filter(x => x.s.group === g.id && x.s.actualMinutes != null);
    if (!slides.length) return { id: g.id, target: g.minutes, n: 0 };
    const vals = slides.map(x => x.s.actualMinutes);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return { id: g.id, target: g.minutes, n: vals.length, mean, min, max };
  });

  const delays = [];
  state.patients.forEach(p => {
    const started = p.slides.filter(s => s.fixStart != null).sort((a, b) => a.fixStart - b.fixStart);
    if (started.length < 2) return;
    const first = started[0].fixStart;
    started.slice(1).forEach(s => {
      delays.push((s.fixStart - first) / 1000);
    });
  });
  const meanDelay = delays.length ? (delays.reduce((a, b) => a + b, 0) / delays.length) : null;
  const maxDelay = delays.length ? Math.max(...delays) : null;

  el.innerHTML = `<div class="card">
    <h3 style="font-size:.85rem;margin:0 0 10px;color:#334155">Slide status</h3>
    <div class="timing-summary-grid">
      <div class="stat"><div class="n">${stats.total}</div><div class="l">Total</div></div>
      <div class="stat"><div class="n">${stats.pending}</div><div class="l">Pending</div></div>
      <div class="stat"><div class="n">${stats.fixing}</div><div class="l">Fixing</div></div>
      <div class="stat"><div class="n">${stats.drying}</div><div class="l">Drying</div></div>
      <div class="stat"><div class="n">${stats.staining}</div><div class="l">Staining</div></div>
      <div class="stat"><div class="n">${stats.done}</div><div class="l">Done</div></div>
    </div>

    <h3 style="font-size:.85rem;margin:16px 0 10px;color:#334155">Fixation accuracy per group</h3>
    <table class="timeline-table">
      <thead><tr>
        <th>Group</th><th>Target</th><th>n</th><th>Mean actual</th><th>Min</th><th>Max</th><th>Δ from target</th>
      </tr></thead>
      <tbody>
        ${groupStats.map(g => {
    if (g.n === 0) return `<tr><td><b>${escHtml(g.id)}</b></td><td>${fmtMin(g.target)}</td><td colspan="5" class="pending">No data yet</td></tr>`;
    const delta = g.mean - g.target;
    const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(2) + ' min';
    const deltaCls = Math.abs(delta / Math.max(g.target, 1)) < 0.05 ? 'on-time' : 'delayed';
    return `<tr>
            <td><b>${escHtml(g.id)}</b></td>
            <td>${fmtMin(g.target)}</td>
            <td>${g.n}</td>
            <td>${g.mean.toFixed(2)} min</td>
            <td>${g.min.toFixed(2)}</td>
            <td>${g.max.toFixed(2)}</td>
            <td class="${deltaCls}">${deltaStr}</td>
          </tr>`;
  }).join('')}
      </tbody>
    </table>

    <h3 style="font-size:.85rem;margin:16px 0 10px;color:#334155">Delay between slides (within patient)</h3>
    <p class="muted" style="margin:0">
      ${delays.length
      ? `Mean <b>${meanDelay.toFixed(1)}s</b> · Max <b>${maxDelay.toFixed(1)}s</b> · n=${delays.length} intervals across ${state.patients.length} patients`
      : 'No intervals recorded yet. Start at least two slides per patient to see delays.'}
    </p>
  </div>`;
}

function renderTimingPatients() {
  const el = $('timingPatients');
  if (!el) return;

  if (!state.patients.length) {
    el.innerHTML = '<div class="card"><p class="muted" style="margin:0">No patients registered yet.</p></div>';
    return;
  }

  const sorted = state.patients.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  el.innerHTML = sorted.map(p => {
    const startedSlides = p.slides.filter(s => s.fixStart != null).sort((a, b) => a.fixStart - b.fixStart);
    const pendingSlides = p.slides.filter(s => s.status === 'pending');
    const firstStart = startedSlides.length ? startedSlides[0].fixStart : null;

    const fixationRows = startedSlides.map((s, i) => {
      const delay = firstStart ? (s.fixStart - firstStart) / 1000 : 0;
      const outAt = s.fixEndActual ? clockHHMM(s.fixEndActual) : (s.status === 'fixing' ? '<span class="live">ongoing</span>' : clockHHMM(s.fixEnd));
      const actual = s.actualMinutes != null ? s.actualMinutes.toFixed(2) + ' min' : '<span class="live">live</span>';
      const delayCls = i === 0 ? 'pending' : (delay > 30 ? 'delayed' : 'on-time');
      return `<tr>
        <td><b>${escHtml(s.group)}</b></td>
        <td>${fmtMin(s.fixMinutes)}</td>
        <td class="time-col">${clockHHMM(s.fixStart)}</td>
        <td class="time-col">${outAt}</td>
        <td>${actual}</td>
        <td class="${delayCls}">${i === 0 ? '—' : '+' + delay.toFixed(1) + 's'}</td>
      </tr>`;
    }).join('');

    const pendingRows = pendingSlides.map(s => `<tr>
      <td><b>${escHtml(s.group)}</b></td>
      <td>${fmtMin(s.fixMinutes)}</td>
      <td colspan="4" class="pending">Not started yet</td>
    </tr>`).join('');

    const dryingSlides = p.slides.filter(s => s.fixEndActual);
    const dryingRows = dryingSlides.map(s => {
      const batch = state.batches.find(b => b.slides.includes(s.code));
      const dryingStart = s.fixEndActual;
      let dryingEnd = null, dryingStatus = '';
      if (batch && batch.startedAt) {
        dryingEnd = batch.startedAt;
        dryingStatus = ((dryingEnd - dryingStart) / 60000).toFixed(1) + ' min';
      } else if (['drying', 'staining', 'stained', 'cleared', 'scored'].includes(s.status) && !batch) {
        dryingStatus = '<span class="live">' + ((Date.now() - dryingStart) / 60000).toFixed(1) + ' min (live)</span>';
      } else {
        dryingStatus = '—';
      }
      return `<tr>
        <td><b>${escHtml(s.group)}</b></td>
        <td class="time-col">${clockHHMM(dryingStart)}</td>
        <td class="time-col">${dryingEnd ? clockHHMM(dryingEnd) : '—'}</td>
        <td>${dryingStatus}</td>
      </tr>`;
    }).join('');

    const batches = state.batches.filter(b => b.slides.some(c => c.startsWith(p.id + '-')));
    const stainingRows = batches.flatMap(b => {
      const steps = (b.stepLog || []).map(s => {
        const diff = (typeof s.actualSec === 'number' && typeof s.plannedSec === 'number') ? s.actualSec - s.plannedSec : null;
        const diffStr = diff != null ? ((diff >= 0 ? '+' : '') + diff + 's') : '—';
        const diffCls = diff != null && Math.abs(diff) > 30 ? 'delayed' : 'on-time';
        return `<tr class="step-row">
          <td>${s.stepNum}. ${escHtml(s.stepName)}</td>
          <td>${s.actualSec != null ? s.actualSec + 's' : '<span class="pending">—</span>'}</td>
          <td>${s.plannedSec != null ? s.plannedSec + 's' : '—'}</td>
          <td class="${diffCls}">${diffStr}</td>
        </tr>`;
      }).join('');
      const totalActual = (b.stepLog || []).reduce((a, s) => a + (s.actualSec || 0), 0);
      const totalPlanned = (b.stepLog || []).reduce((a, s) => a + (s.plannedSec || 0), 0);
      const header = `<tr class="batch-row">
        <td colspan="1">${b.id} · ${b.slides.length} slides · v${b.protocolVersion || 1}</td>
        <td>${totalActual}s</td>
        <td>${totalPlanned}s</td>
        <td>${b.completedAt ? '✓ ' + clockHHMM(b.completedAt) : '<span class="live">running</span>'}</td>
      </tr>`;
      return header + steps;
    }).join('');

    const allTs = [];
    p.slides.forEach(s => {
      if (s.fixStart) allTs.push(s.fixStart);
      if (s.fixEndActual) allTs.push(s.fixEndActual);
    });
    batches.forEach(b => {
      if (b.startedAt) allTs.push(b.startedAt);
      if (b.completedAt) allTs.push(b.completedAt);
    });
    const span = allTs.length >= 2 ? ((Math.max(...allTs) - Math.min(...allTs)) / 60000).toFixed(0) : null;

    return `<div class="timing-patient-card">
      <div class="timing-patient-header">
        <div>
          <div class="pid">${p.id}${p.simulated ? '<span class="sim-badge">SIM</span>' : ''}</div>
          ${p.name ? `<div class="pmeta">${escHtml(p.name)}</div>` : ''}
          <div class="pmeta">Age ${p.age} · ${p.sex} · Smoking: ${p.smoking}</div>
        </div>
        <div class="pspan">
          ${firstStart ? `First slide into fixative: <b>${clockHHMM(firstStart)}</b><br>` : '<span class="pending">Not started</span><br>'}
          ${span != null ? `Total span: <b>${span} min</b>` : ''}
          ${pendingSlides.length ? `<br><span class="pending">${pendingSlides.length} slide${pendingSlides.length > 1 ? 's' : ''} still pending</span>` : ''}
        </div>
      </div>

      ${startedSlides.length || pendingSlides.length ? `
      <div class="timeline-section">
        <h4>⏱ Fixation</h4>
        <table class="timeline-table">
          <thead><tr><th>Group</th><th>Target</th><th>In at</th><th>Out at</th><th>Actual</th><th>Delay from first</th></tr></thead>
          <tbody>${fixationRows}${pendingRows}</tbody>
        </table>
      </div>` : ''}

      ${dryingSlides.length ? `
      <div class="timeline-section">
        <h4>💧 Drying</h4>
        <table class="timeline-table">
          <thead><tr><th>Group</th><th>In container at</th><th>Staining started at</th><th>Drying time</th></tr></thead>
          <tbody>${dryingRows}</tbody>
        </table>
      </div>` : ''}

      ${batches.length ? `
      <div class="timeline-section">
        <h4>🎨 Staining</h4>
        <table class="timeline-table">
          <thead><tr><th>Batch · step</th><th>Actual</th><th>Planned</th><th>Diff / status</th></tr></thead>
          <tbody>${stainingRows}</tbody>
        </table>
      </div>` : ''}

      ${!startedSlides.length && !pendingSlides.length && !batches.length ? '<p class="muted" style="margin:0">No timing data yet. Start fixation to populate this timeline.</p>' : ''}
    </div>`;
  }).join('');
}

function exportTimingCSV() {
  if (!state.patients.length) { toast('No data to export yet'); return; }
  const head = [
    'PatientID', 'SlideCode', 'Group', 'TargetFix_min', 'Delay_config_sec',
    'InFixative_ISO', 'InFixative_clock', 'OutFixative_ISO', 'OutFixative_clock',
    'ActualFix_min', 'Delay_from_first_slide_sec',
    'DryingStart_clock', 'StainingStart_clock', 'Drying_min',
    'Batch', 'BatchStart_clock', 'BatchEnd_clock', 'BatchTotal_sec'
  ];
  const rows = [head];

  state.patients.forEach(p => {
    const started = p.slides.filter(s => s.fixStart != null).sort((a, b) => a.fixStart - b.fixStart);
    const firstStart = started.length ? started[0].fixStart : null;

    p.slides.forEach(s => {
      if (!s.fixStart) return;
      const batch = state.batches.find(b => b.slides.includes(s.code));
      const dryingStart = s.fixEndActual;
      const stainingStart = batch ? batch.startedAt : null;
      const dryingMin = (dryingStart && stainingStart) ? ((stainingStart - dryingStart) / 60000).toFixed(1) : '';
      const delay = firstStart ? ((s.fixStart - firstStart) / 1000).toFixed(1) : '';
      const batchTotal = batch && batch.stepLog ? batch.stepLog.reduce((a, x) => a + (x.actualSec || 0), 0) : '';

      rows.push([
        p.id, s.code, s.group, s.fixMinutes, s.delaySec || 0,
        new Date(s.fixStart).toISOString(), clockHHMM(s.fixStart),
        s.fixEndActual ? new Date(s.fixEndActual).toISOString() : '',
        s.fixEndActual ? clockHHMM(s.fixEndActual) : '',
        s.actualMinutes != null ? s.actualMinutes.toFixed(2) : '',
        delay,
        dryingStart ? clockHHMM(dryingStart) : '',
        stainingStart ? clockHHMM(stainingStart) : '',
        dryingMin,
        batch ? batch.id : '',
        batch ? clockHHMM(batch.startedAt) : '',
        batch && batch.completedAt ? clockHHMM(batch.completedAt) : '',
        batchTotal
      ]);
    });
  });

  const stamp = new Date().toISOString().slice(0, 10);
  download(`pap_timing_${stamp}.csv`, rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
  toast(`Timing report exported (${rows.length - 1} slides)`);
}

/* ===================== DASHBOARD ===================== */
function renderDashboard() {
  if (!$('heroPatients') || !$('actionQueue') || !$('groupProgress') || !$('stats')) {
    console.warn('Dashboard elements missing — skipping render');
    return;
  }
  const all = allSlides();
  const totalPatients = state.patients.length;
  const scoredSlides = all.filter(x => x.s.status === 'scored').length;
  const simCount = state.patients.filter(p => p.simulated).length;

  const maxPatients = getMaxPatients();
  const targetSlides = getTargetSlides();

  const patPct = Math.min(100, (totalPatients / maxPatients) * 100);
  const scoredPct = Math.min(100, (scoredSlides / targetSlides) * 100);

  $('heroPatients').textContent = totalPatients;
  $('heroMaxPatients').textContent = maxPatients;
  $('heroScored').textContent = scoredSlides;
  $('heroTargetSlides').textContent = targetSlides;
  $('heroPatientsBar').style.width = patPct + '%';
  $('heroScoredBar').style.width = scoredPct + '%';

  $('heroSimBadge').innerHTML = simCount > 0
    ? `<span class="sim-badge" style="background:rgba(255,255,255,.25);color:#fff">${simCount} SIM</span>`
    : '';

  renderActionQueue(all);

  const groups = getGroups();
  $('groupProgress').innerHTML = groups.map(g => {
    const groupSlides = all.filter(x => x.s.group === g.id);
    const groupScored = groupSlides.filter(x => x.s.status === 'scored').length;
    const pct = Math.min(100, (groupScored / maxPatients) * 100);
    const complete = groupScored >= maxPatients;
    const extra = groupSlides.length !== maxPatients && groupSlides.length > 0
      ? `<span class="extra">${groupSlides.length} registered</span>`
      : `<span class="extra">${Math.round(pct)}%</span>`;
    return `<div class="group-item ${complete ? 'complete' : ''}">
      <div class="group-head">
        <span class="group-letter">${escHtml(g.id)}</span>
        <span class="group-target">${fmtMin(g.minutes)}</span>
      </div>
      <div class="group-bar"><div class="group-bar-fill" style="width:${pct}%"></div></div>
      <div class="group-count">
        <span>${groupScored} / ${maxPatients} scored</span>
        ${extra}
      </div>
    </div>`;
  }).join('');

  const pending = all.filter(x => x.s.status === 'pending').length;
  const fixing = all.filter(x => x.s.status === 'fixing').length;
  const ready = all.filter(x => x.s.status === 'fixing' && Date.now() >= x.s.fixEnd).length;
  const drying = all.filter(x => x.s.status === 'drying').length;
  const staining = all.filter(x => x.s.status === 'staining').length;
  const stained = all.filter(x => x.s.status === 'stained').length;
  const cleared = all.filter(x => x.s.status === 'cleared').length;

  $('stats').innerHTML = `
    <div class="stat"><div class="n">${pending}</div><div class="l">Pending</div></div>
    <div class="stat"><div class="n">${fixing}</div><div class="l">Fixing</div></div>
    <div class="stat"><div class="n">${ready}</div><div class="l">Ready</div></div>
    <div class="stat"><div class="n">${drying}</div><div class="l">In container</div></div>
    <div class="stat"><div class="n">${staining}</div><div class="l">Staining</div></div>
    <div class="stat"><div class="n">${stained}</div><div class="l">To clear</div></div>
    <div class="stat"><div class="n">${cleared}</div><div class="l">To score</div></div>
    <div class="stat"><div class="n">${scoredSlides}</div><div class="l">Scored</div></div>`;
}

function renderActionQueue(all) {
  if (state.patients.length === 0) {
    $('actionQueue').innerHTML = `
      <div class="action-empty">
        <div class="emoji">👋</div>
        <div class="title">Ready to begin</div>
        <div class="muted" style="margin-bottom:12px">Register your first patient to start data collection.</div>
        <button class="btn" onclick="goToReceptionAndRegister()">+ Register first patient</button>
      </div>`;
    return;
  }

  const urgent = [], attention = [], info = [];

  const readySlides = all.filter(x => x.s.status === 'fixing' && Date.now() >= x.s.fixEnd);
  if (readySlides.length) urgent.push({ label: `<b>${readySlides.length}</b> slide${readySlides.length > 1 ? 's' : ''} READY — take to empty container`, tab: 'fixation' });

  state.batches.filter(b => b.status === 'running').forEach(b => {
    const step = batchProtocol(b)[b.stepIndex];
    if (b.stepRunning && Date.now() >= b.stepEnd && step) {
      urgent.push({ label: `Batch ${b.id}: "${escHtml(step.name)}" finished — advance`, tab: 'staining' });
    }
  });

  const pendingPats = state.patients.filter(p => p.slides.some(s => s.status === 'pending'));
  if (pendingPats.length) attention.push({ label: `<b>${pendingPats.length}</b> patient${pendingPats.length > 1 ? 's' : ''} with pending slides — start fixation`, tab: 'fixation' });

  const dryingSlides = all.filter(x => x.s.status === 'drying');
  if (dryingSlides.length) attention.push({ label: `<b>${dryingSlides.length}</b> slide${dryingSlides.length > 1 ? 's' : ''} in empty container — ready to stain`, tab: 'staining' });

  state.batches.filter(b => b.status === 'running').forEach(b => {
    const step = batchProtocol(b)[b.stepIndex];
    if (!b.stepRunning && step) {
      attention.push({ label: `Batch ${b.id}: step ${b.stepIndex + 1} "${escHtml(step.name)}" not started`, tab: 'staining' });
    }
  });

  const stainedSlides = all.filter(x => x.s.status === 'stained');
  if (stainedSlides.length) attention.push({ label: `<b>${stainedSlides.length}</b> slide${stainedSlides.length > 1 ? 's' : ''} awaiting clear & mount confirmation`, tab: 'clearmount' });

  const clearedSlides = all.filter(x => x.s.status === 'cleared');
  if (clearedSlides.length) info.push({ label: `<b>${clearedSlides.length}</b> slide${clearedSlides.length > 1 ? 's' : ''} ready for quality scoring`, tab: 'scoring' });

  if (!urgent.length && !attention.length && !info.length) {
    $('actionQueue').innerHTML = `
      <div class="action-empty">
        <div class="emoji">✅</div>
        <div class="title">All caught up</div>
        <div class="muted">No actions pending right now.</div>
      </div>`;
    return;
  }

  let html = '<h2>⚡ Needs attention</h2>';
  if (urgent.length) {
    html += `<div class="action-group"><div class="action-group-title urgent">🔴 Urgent</div>
      ${urgent.map(a => `<div class="action-item urgent"><span>${a.label}</span><button class="action-go" onclick="goToTab('${a.tab}')">Go →</button></div>`).join('')}
    </div>`;
  }
  if (attention.length) {
    html += `<div class="action-group"><div class="action-group-title attention">🟡 Attention</div>
      ${attention.map(a => `<div class="action-item attention"><span>${a.label}</span><button class="action-go" onclick="goToTab('${a.tab}')">Go →</button></div>`).join('')}
    </div>`;
  }
  if (info.length) {
    html += `<div class="action-group"><div class="action-group-title info">🔵 Ready to progress</div>
      ${info.map(a => `<div class="action-item info"><span>${a.label}</span><button class="action-go" onclick="goToTab('${a.tab}')">Go →</button></div>`).join('')}
    </div>`;
  }
  $('actionQueue').innerHTML = html;
}

/* ===================== SETTINGS ===================== */
function openSettingsTab() {
  $('setMaxPatients').value = state.settings.maxPatients;
  $('setGroupCount').value = state.settings.groupLabels.length;
  renderGroupEditor();
  renderSettingsLockBanner();
  renderSettingsProtocolPreview();
  renderSettingsAppInfo();
}

function renderSettingsLockBanner() {
  const hasPatients = state.patients.length > 0;
  const el = $('settingsLockBanner');
  if (!el) return;
  if (hasPatients) {
    el.innerHTML = `<div class="lock-banner">
      <b>🔒 Group structure locked.</b> You have <b>${state.patients.length}</b> patient${state.patients.length > 1 ? 's' : ''} registered.
      Group count, labels, fixation times, and delays cannot be changed. <b>You can still change "Max patients".</b>
      To change the group structure, delete all patients first (Data → Delete ALL data).
    </div>`;
    $('setGroupCount').disabled = true;
  } else {
    el.innerHTML = `<div class="info-banner">
      ✅ No patients yet — you can freely configure study parameters below.
      Once you register your first patient, group structure will be locked.
    </div>`;
    $('setGroupCount').disabled = false;
  }
}

function onGroupCountChange() {
  if (state.patients.length > 0) {
    toast('Group count is locked once patients exist');
    $('setGroupCount').value = state.settings.groupLabels.length;
    return;
  }
  let count = parseInt($('setGroupCount').value, 10);
  if (isNaN(count) || count < 1) count = 1;
  if (count > 10) count = 10;
  $('setGroupCount').value = count;

  const curLabels = state.settings.groupLabels;
  const curTimes = state.settings.groupTimes;
  const curDelays = state.settings.groupDelays;
  const newLabels = [], newTimes = [], newDelays = [];
  const defaultTimes = [1, 10, 15, 60, 1440, 2880, 4320, 7200, 10080, 20160];

  for (let i = 0; i < count; i++) {
    newLabels.push(curLabels[i] !== undefined ? curLabels[i] : String.fromCharCode(65 + i));
    newTimes.push(curTimes[i] !== undefined ? curTimes[i] : (defaultTimes[i] || (i + 1) * 60));
    newDelays.push(curDelays[i] !== undefined ? curDelays[i] : 0);
  }
  state.settings.groupLabels = newLabels;
  state.settings.groupTimes = newTimes;
  state.settings.groupDelays = newDelays;
  renderGroupEditor();
}

function renderGroupEditor() {
  const el = $('groupEditor');
  if (!el) return;
  const locked = state.patients.length > 0;
  const labels = state.settings.groupLabels;
  const times = state.settings.groupTimes;
  const delays = state.settings.groupDelays;

  el.innerHTML = labels.map((label, i) => {
    const min = times[i] || 0;
    const delay = delays[i] || 0;
    return `<div class="settings-group-row">
      <div class="idx">${i + 1}</div>
      <input type="text" maxlength="6" value="${escHtml(label)}"
             ${locked ? 'disabled' : ''}
             oninput="updateGroupLabel(${i}, this.value)">
      <div class="time-wrap">
        <input type="number" min="0" max="100000" value="${min}"
               ${locked ? 'disabled' : ''}
               oninput="updateGroupTime(${i}, this.value)">
        <span class="time-fmt">min · ${fmtMin(min)}</span>
      </div>
      <div class="delay-wrap">
        <input type="number" min="0" max="600" value="${delay}"
               ${locked ? 'disabled' : ''}
               oninput="updateGroupDelay(${i}, this.value)">
        <span class="delay-unit">s delay</span>
      </div>
    </div>`;
  }).join('');
}

function updateGroupLabel(i, value) {
  if (state.patients.length > 0) return;
  state.settings.groupLabels[i] = value.toUpperCase().trim() || String.fromCharCode(65 + i);
}

function updateGroupTime(i, value) {
  if (state.patients.length > 0) return;
  const v = Math.max(0, parseInt(value, 10) || 0);
  state.settings.groupTimes[i] = v;
  const row = document.querySelectorAll('.settings-group-row')[i];
  if (row) {
    const fmtEl = row.querySelector('.time-fmt');
    if (fmtEl) fmtEl.textContent = `min · ${fmtMin(v)}`;
  }
}

function updateGroupDelay(i, value) {
  if (state.patients.length > 0) return;
  const v = Math.max(0, Math.min(600, parseInt(value, 10) || 0));
  state.settings.groupDelays[i] = v;
}

function saveStudyParameters() {
  const newMax = parseInt($('setMaxPatients').value, 10);
  if (!newMax || newMax < 1) { toast('Max patients must be at least 1'); return; }

  const hasPatients = state.patients.length > 0;
  const newGroupCount = parseInt($('setGroupCount').value, 10);
  const newLabels = state.settings.groupLabels.slice(0, newGroupCount);
  const newTimes = state.settings.groupTimes.slice(0, newGroupCount);
  const newDelays = state.settings.groupDelays.slice(0, newGroupCount);

  const seen = new Set();
  for (let i = 0; i < newLabels.length; i++) {
    const l = (newLabels[i] || '').trim();
    if (!l) { toast(`Group ${i + 1} label cannot be empty`); return; }
    if (seen.has(l)) { toast(`Duplicate group label: "${l}"`); return; }
    seen.add(l);
    if (newTimes[i] < 0) { toast(`Group ${i + 1} time must be ≥ 0`); return; }
    if (newDelays[i] < 0 || newDelays[i] > 600) { toast(`Group ${i + 1} delay must be 0–600s`); return; }
  }

  if (hasPatients) {
    const sameStructure =
      newGroupCount === state.settings.groupLabels.length &&
      newLabels.join('|') === state.settings.groupLabels.join('|') &&
      newTimes.join('|') === state.settings.groupTimes.join('|') &&
      newDelays.join('|') === state.settings.groupDelays.join('|');
    if (!sameStructure) {
      toast('Group structure is locked while patients exist. Only "Max patients" can change.');
      return;
    }
  }

  state.settings.maxPatients = newMax;
  state.settings.groupLabels = newLabels;
  state.settings.groupTimes = newTimes;
  state.settings.groupDelays = newDelays;
  save();
  renderAll();
  toast(`Study parameters saved — ${newLabels.length} group${newLabels.length === 1 ? '' : 's'}, ${newMax} max patients`);
}

function resetStudyParametersToDefault() {
  if (state.patients.length > 0) {
    if (!confirm('Group structure is locked while patients exist. Only "Max patients" will be reset to 40. Continue?')) return;
    state.settings.maxPatients = DEFAULT_SETTINGS.maxPatients;
  } else {
    if (!confirm('Reset study parameters to default (40 patients, groups A–E at 1/10/15/60/1440 min, all delays 0)?')) return;
    state.settings = deepCopySettings(DEFAULT_SETTINGS);
  }
  save();
  openSettingsTab();
  renderAll();
  toast('Study parameters reset');
}

function renderSettingsProtocolPreview() {
  const previewEl = $('protocolPreview');
  const countEl = $('protocolStepCountSettings');
  const totalEl = $('protocolTotalTime');
  const verEl = $('protocolVersionDisplay');
  if (!previewEl) return;

  const steps = state.protocol;
  const totalSec = steps.reduce((a, s) => a + (s.sec || 0), 0);
  const manualCount = steps.filter(s => s.sec === 0).length;

  previewEl.innerHTML = `<ol>${steps.map(s => {
    const dur = s.sec === 0 ? 'manual' : fmtStepDuration(s.sec);
    return `<li>${escHtml(s.name)} <span class="muted">· ${dur}</span></li>`;
  }).join('')}</ol>`;

  if (countEl) countEl.textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  if (totalEl) totalEl.textContent = manualCount > 0
    ? `${fmt(totalSec * 1000)} + ${manualCount} manual`
    : fmt(totalSec * 1000);
  if (verEl) verEl.textContent = 'v' + state.protocolVersion;
}

function renderSettingsAppInfo() {
  const patCount = state.patients.length;
  const slideCount = allSlides().length;
  const activeBatches = state.batches.filter(b => b.status === 'running').length;

  if ($('infoPatientCount')) $('infoPatientCount').textContent = patCount;
  if ($('infoSlideCount')) $('infoSlideCount').textContent = slideCount;
  if ($('infoBatchCount')) $('infoBatchCount').textContent = activeBatches;

  if ($('infoStorage')) {
    try {
      const raw = localStorage.getItem(LS_KEY) || '';
      const bytes = new Blob([raw]).size;
      const kb = (bytes / 1024).toFixed(1);
      const pct = ((bytes / (5 * 1024 * 1024)) * 100).toFixed(1);
      $('infoStorage').textContent = `${kb} KB (${pct}% of ~5 MB limit)`;
    } catch (e) { $('infoStorage').textContent = '—'; }
  }
}

/* ===================== PROTOCOL EDITOR ===================== */
function openProtocolEditor() {
  tempProtocol = deepCopyProtocol(state.protocol);
  $('protocolModalTitle').textContent = `Edit staining protocol (v${state.protocolVersion}, ${state.protocol.length} steps)`;
  renderProtocolEditor();
  $('modal-protocol').classList.remove('hidden');
}

function renderProtocolEditor() {
  const running = state.batches.filter(b => b.status === 'running').length;
  const warning = running > 0 ? `
    <div class="warnbox" style="background:#fef2f2;border-color:#fca5a5;color:#991b1b">
      <b>⚠ ${running} batch${running > 1 ? 'es' : ''} currently running.</b>
      Running batches use their own frozen protocol snapshot — they are not affected by your edits.
      Only <b>future</b> batches will use the new protocol.
    </div>` : '';

  let html = warning;
  html += `<p class="muted" style="margin-top:0;line-height:1.6">
    Rename steps, adjust durations, reorder with ▲▼, or add/remove. Set both min and sec to <b>0</b> for a manual step.
    Saving increments the protocol version.
  </p>`;

  tempProtocol.forEach((step, i) => {
    const min = Math.floor(step.sec / 60);
    const sec = step.sec % 60;
    html += `<div class="protocol-row" data-idx="${i}">
      <div class="protocol-move">
        <button class="btn ghost sm" onclick="moveProtocolStep(${i},-1)" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="btn ghost sm" onclick="moveProtocolStep(${i},1)" ${i === tempProtocol.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
      <div class="protocol-body">
        <div class="protocol-label">Step ${i + 1}</div>
        <input class="protocol-name-input" type="text" value="${escHtml(step.name)}"
               oninput="updateProtocolName(${i}, this.value)">
        <div class="protocol-dur">
          <input type="number" min="0" max="999" value="${min}" oninput="updateProtocolDur(${i},'min',this.value)">
          <span class="unit">min</span>
          <input type="number" min="0" max="59" value="${sec}" oninput="updateProtocolDur(${i},'sec',this.value)">
          <span class="unit">sec</span>
          <span class="dur-hint" data-hint="${i}">${step.sec === 0 ? 'manual (no timer)' : 'auto-timer'}</span>
        </div>
      </div>
      <button class="btn danger btn-del" onclick="deleteProtocolStep(${i})" ${tempProtocol.length === 1 ? 'disabled' : ''}>🗑</button>
    </div>`;
  });

  html += `<button class="btn ghost sm" onclick="addProtocolStep()" style="margin-top:4px">+ Add step</button>`;
  html += `<div class="row" style="margin-top:14px">
    <button class="btn" onclick="saveProtocol()">💾 Save changes</button>
    <button class="btn ghost" onclick="closeProtocolEditor()">Cancel</button>
    <button class="btn ghost" style="margin-left:auto;color:#dc2626" onclick="resetProtocolToDefault()">↺ Reset to default</button>
  </div>`;

  $('protocolBody').innerHTML = html;
}

function updateProtocolName(i, value) { if (tempProtocol[i]) tempProtocol[i].name = value; }

function updateProtocolDur(i, part, value) {
  if (!tempProtocol[i]) return;
  const v = Math.max(0, parseInt(value, 10) || 0);
  const curMin = Math.floor(tempProtocol[i].sec / 60);
  const curSec = tempProtocol[i].sec % 60;
  if (part === 'min') tempProtocol[i].sec = Math.min(999, v) * 60 + curSec;
  else tempProtocol[i].sec = curMin * 60 + Math.min(59, v);
  const hint = document.querySelector(`[data-hint="${i}"]`);
  if (hint) hint.textContent = tempProtocol[i].sec === 0 ? 'manual (no timer)' : 'auto-timer';
}

function moveProtocolStep(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= tempProtocol.length) return;
  [tempProtocol[i], tempProtocol[j]] = [tempProtocol[j], tempProtocol[i]];
  renderProtocolEditor();
}

function deleteProtocolStep(i) {
  if (tempProtocol.length <= 1) { toast('Protocol needs at least 1 step'); return; }
  if (!confirm(`Delete step ${i + 1} "${tempProtocol[i].name}"?`)) return;
  tempProtocol.splice(i, 1);
  renderProtocolEditor();
}

function addProtocolStep() { tempProtocol.push({ name: 'New step', sec: 60 }); renderProtocolEditor(); }

function resetProtocolToDefault() {
  if (!confirm('Replace editor contents with default protocol?\n\nNot saved until you click "💾 Save changes".')) return;
  tempProtocol = deepCopyProtocol(DEFAULT_PROTOCOL);
  renderProtocolEditor();
}

function saveProtocol() {
  for (let i = 0; i < tempProtocol.length; i++) {
    if (!tempProtocol[i].name || !tempProtocol[i].name.trim()) {
      toast(`Step ${i + 1} needs a name`);
      return;
    }
  }
  const newProto = tempProtocol.map(s => ({ name: s.name.trim(), sec: Math.max(0, s.sec | 0) }));
  const changed = !deepEqualProtocol(state.protocol, newProto);
  if (changed) state.protocolVersion += 1;
  state.protocol = newProto;
  save();
  closeModal('modal-protocol');
  tempProtocol = null;
  renderAll();
  toast(changed ? `Protocol saved — now v${state.protocolVersion}` : 'Protocol unchanged');
}

/* ===================== SIMULATE ===================== */
function simulateFullWork() {
  const maxPatients = getMaxPatients();
  const groups = getGroups();
  const totalSlides = maxPatients * groups.length;

  let msg = `This will ADD ${maxPatients} simulated patients (${totalSlides} slides).\n\n` +
    `Groups: ${groups.map(g => `${g.id}=${fmtMin(g.minutes)}`).join(', ')}\n\n` +
    'All slides will be marked fully scored. Simulated patients can be removed anytime from the Data tab.';
  if (state.patients.length > 0) msg = `You currently have ${state.patients.length} patient(s).\n\n` + msg;
  msg += '\n\nContinue?';
  if (!confirm(msg)) return;

  const maleNames = ['Ahmed', 'Mohamed', 'Omar', 'Khalid', 'Hassan', 'Yousif', 'Ali', 'Ibrahim', 'Mustafa', 'Adam', 'Musa', 'Osman', 'Tariq', 'Yasir', 'Mazin'];
  const femaleNames = ['Fatima', 'Sara', 'Mariam', 'Aisha', 'Hawa', 'Noura', 'Amna', 'Hiba', 'Rania', 'Layla', 'Zainab', 'Safia', 'Maha', 'Reem', 'Salma'];
  const familyNames = ['Ahmed', 'Hassan', 'Omer', 'Ibrahim', 'Mohamed', 'Ali', 'Yousif', 'Khalid', 'Osman', 'Adam', 'Mahmoud', 'Abdalla'];
  const notesPool = ['', '', '', '', '', '', 'Slight cheek irritation', 'Recent dental work', 'Follow-up visit', 'Cooperative patient', 'Sensitive gums', 'Dry mouth reported'];

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const regWindowStart = now - 10 * day;

  let maxSim = 0;
  state.patients.filter(p => p.simulated).forEach(p => {
    const n = parseInt(p.id.replace('S', ''), 10);
    if (!isNaN(n)) maxSim = Math.max(maxSim, n);
  });

  const newSlideCodes = [];
  const mkScore = (base) => {
    const noise = (Math.random() - 0.5) * 1.6;
    const v = base + noise;
    if (v < 0.6) return 0;
    if (v < 1.6) return 1;
    if (v < 2.5) return 2;
    return 3;
  };
  const baseFor = (min) => {
    if (min < 2) return 1.7;
    if (min < 12) return 2.2;
    if (min < 30) return 2.6;
    if (min < 180) return 2.7;
    return 2.5;
  };

  for (let i = 0; i < maxPatients; i++) {
    const simNum = maxSim + i + 1;
    const id = 'S' + String(simNum).padStart(2, '0');
    const age = 18 + Math.floor(Math.random() * 43);
    const sex = Math.random() < 0.5 ? 'Male' : 'Female';
    const firstName = sex === 'Male'
      ? maleNames[Math.floor(Math.random() * maleNames.length)]
      : femaleNames[Math.floor(Math.random() * femaleNames.length)];
    const name = `${firstName} ${familyNames[Math.floor(Math.random() * familyNames.length)]}`;
    const smoking = Math.random() < 0.2 ? 'Yes' : 'No';
    const notes = notesPool[Math.floor(Math.random() * notesPool.length)];
    const regTime = regWindowStart + Math.floor(Math.random() * (6 * day));
    const t0 = regTime + Math.floor(Math.random() * 5 * 60 * 1000);

    const slides = groups.map(g => {
      const slideFixStart = t0 + (g.delaySec || 0) * 1000;
      const targetMs = g.minutes * 60000;
      const maxJitterMs = g.minutes <= 15 ? 25000 : (g.minutes === 60 ? 90000 : 180000);
      const jitter = Math.floor(Math.random() * maxJitterMs);
      const fixEnd = slideFixStart + targetMs;
      const fixEndActual = fixEnd + jitter;
      const actualMinutes = (fixEndActual - slideFixStart) / 60000;
      const base = baseFor(g.minutes);
      const o1 = {}, o2 = {};
      PARAMS.forEach(par => {
        o1[par.k] = mkScore(base);
        const diff = Math.random() < 0.25 ? (Math.random() < 0.5 ? -1 : 1) : 0;
        o2[par.k] = Math.max(0, Math.min(3, o1[par.k] + diff));
      });
      return {
        code: `${id}-${g.id}`, group: g.id, fixMinutes: g.minutes, delaySec: g.delaySec || 0,
        fixStart: slideFixStart, fixEnd, fixEndActual, actualMinutes,
        status: 'scored', notified: true, scores: { o1, o2 }
      };
    });

    state.patients.push({
      id, name, age, sex, smoking, notes,
      t0, slides, createdAt: regTime, simulated: true
    });
    newSlideCodes.push(...slides.map(s => s.code));
  }

  const shuffled = newSlideCodes.slice().sort(() => Math.random() - 0.5);
  const batchSize = 20;
  let maxSimBatch = 0;
  state.batches.filter(b => b.id.startsWith('SB')).forEach(b => {
    const n = parseInt(b.id.replace('SB', ''), 10);
    if (!isNaN(n)) maxSimBatch = Math.max(maxSimBatch, n);
  });

  for (let i = 0; i < shuffled.length; i += batchSize) {
    const codes = shuffled.slice(i, i + batchSize);
    maxSimBatch++;
    const bid = 'SB' + String(maxSimBatch).padStart(2, '0');
    const batchStart = now - 3 * day + Math.floor(Math.random() * 2 * day);
    const completedAt = batchStart + 20 * 60 * 1000;
    state.batches.push({
      id: bid, slides: codes,
      stepIndex: state.protocol.length - 1,
      stepStart: completedAt - 60000, stepEnd: completedAt, stepRunning: false,
      startedAt: batchStart, completedAt,
      status: 'done', notified: true,
      protocolSnapshot: deepCopyProtocol(state.protocol),
      protocolVersion: state.protocolVersion,
      stepLog: []
    });
  }

  save(); renderAll(); beep(2);
  toast(`✅ Simulated ${maxPatients} patients · ${totalSlides} slides`);
}

function clearSimulated() {
  const sims = state.patients.filter(p => p.simulated);
  if (!sims.length) { toast('No simulated patients to remove'); return; }
  if (!confirm(`Remove ${sims.length} simulated patient(s) and their data? This cannot be undone.`)) return;
  const simIds = new Set(sims.map(p => p.id));
  state.patients = state.patients.filter(p => !p.simulated);
  state.batches = state.batches.filter(b => {
    b.slides = b.slides.filter(c => !simIds.has(c.split('-')[0]));
    return b.slides.length > 0;
  });
  save(); renderAll();
  toast(`Removed ${sims.length} simulated patient(s)`);
}

function updateSimStats() {
  const sims = state.patients.filter(p => p.simulated);
  const simSlides = sims.reduce((a, p) => a + p.slides.length, 0);
  const simBatches = state.batches.filter(b => b.id.startsWith('SB')).length;
  const card = $('simulatedCard');
  if (!card) return;
  if (!sims.length) {
    $('simStats').innerHTML = '<p class="muted" style="margin:0">No simulated data present.</p>';
    card.querySelector('button').disabled = true;
    card.querySelector('button').style.opacity = '0.5';
    card.querySelector('button').style.cursor = 'not-allowed';
  } else {
    $('simStats').innerHTML = `<div class="grid">
      <div class="stat"><div class="n">${sims.length}</div><div class="l">Sim. patients</div></div>
      <div class="stat"><div class="n">${simSlides}</div><div class="l">Sim. slides</div></div>
      <div class="stat"><div class="n">${simBatches}</div><div class="l">Sim. batches</div></div>
    </div>`;
    card.querySelector('button').disabled = false;
    card.querySelector('button').style.opacity = '';
    card.querySelector('button').style.cursor = '';
  }
}

/* ===================== EXPORT ===================== */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

function exportCSV() {
  if (!state.patients.length) { toast('No data to export yet'); return; }
  const hasSimulated = state.patients.some(p => p.simulated);
  const head = [
    'PatientID', ...(hasSimulated ? ['Simulated'] : []),
    'Name', 'Age', 'Sex', 'Smoking', 'Notes',
    'SlideCode', 'Group', 'TargetFix_min', 'Delay_sec', 'ActualFix_min',
    'O1_Nuclear', 'O1_Cytoplasmic', 'O1_Morphology', 'O1_Background', 'O1_Overall', 'O1_Total', 'O1_Class',
    'O2_Nuclear', 'O2_Cytoplasmic', 'O2_Morphology', 'O2_Background', 'O2_Overall', 'O2_Total', 'O2_Class'
  ];
  const rows = [head];
  allSlides().forEach(({ p, s }) => {
    const sc = scoreOf(s);
    rows.push([
      p.id, ...(hasSimulated ? [p.simulated ? 'Yes' : 'No'] : []),
      p.name, p.age, p.sex, p.smoking, p.notes,
      s.code, s.group, s.fixMinutes, s.delaySec || 0,
      s.actualMinutes != null ? s.actualMinutes.toFixed(2) : '',
      sc ? sc.o1.nuc : '', sc ? sc.o1.cyt : '', sc ? sc.o1.mor : '', sc ? sc.o1.bg : '', sc ? sc.o1.ovr : '',
      sc ? sc.t1 : '', sc ? sc.c1 : '',
      sc ? sc.o2.nuc : '', sc ? sc.o2.cyt : '', sc ? sc.o2.mor : '', sc ? sc.o2.bg : '', sc ? sc.o2.ovr : '',
      sc ? sc.t2 : '', sc ? sc.c2 : ''
    ]);
  });
  const stamp = new Date().toISOString().slice(0, 10);
  download(`pap_study_${stamp}.csv`, rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
  const simCount = state.patients.filter(p => p.simulated).length;
  toast(simCount > 0
    ? `CSV exported (includes ${simCount} SIMULATED patient${simCount > 1 ? 's' : ''})`
    : 'CSV exported (real data only)');
}

function exportStepTimings() {
  const batches = state.batches.filter(b => b.stepLog && b.stepLog.length > 0);
  if (!batches.length) { toast('No batch step timings recorded yet'); return; }
  const head = ['BatchID', 'ProtocolVersion', 'StepNum', 'StepName', 'Planned_sec', 'Actual_sec', 'Diff_sec', 'Start_ISO', 'End_ISO', 'Incomplete'];
  const rows = [head];
  batches.forEach(b => {
    b.stepLog.forEach(s => {
      const diff = (typeof s.actualSec === 'number' && typeof s.plannedSec === 'number') ? (s.actualSec - s.plannedSec) : '';
      rows.push([
        b.id, b.protocolVersion || 1, s.stepNum, s.stepName,
        s.plannedSec, s.actualSec != null ? s.actualSec : '', diff,
        s.startTime ? new Date(s.startTime).toISOString() : '',
        s.endTime ? new Date(s.endTime).toISOString() : '',
        s.incomplete ? 'Yes' : 'No'
      ]);
    });
  });
  const stamp = new Date().toISOString().slice(0, 10);
  download(`pap_step_timings_${stamp}.csv`, rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
  toast(`Exported step timings for ${batches.length} batch${batches.length > 1 ? 'es' : ''}`);
}

const APP_VERSION = '1.4.0';
const SCHEMA_VERSION = 1;

function exportJSON() {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  const payload = {
    _schemaVersion: SCHEMA_VERSION,
    _appVersion: APP_VERSION,
    _exportedAt: now.toISOString(),
    _summary: {
      patients: state.patients.length,
      slides: allSlides().length,
      batches: state.batches.length
    },
    state
  };
  download(`pap_study_backup_${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
  state._lastExportAt = now.getTime();
  save();
  toast('Backup exported');
}

function importJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const parsed = JSON.parse(ev.target.result);
      // Support new wrapped format AND old bare-state format
      const data = (parsed && parsed.state) ? parsed.state : parsed;
      const meta = (parsed && parsed._schemaVersion) ? parsed : null;

      if (!data.patients || !data.batches) throw new Error('bad file');

      let msg = 'This will REPLACE all current data on this device.\n\n';
      if (meta) {
        msg += '📄 Backup details:\n';
        msg += `• Exported: ${new Date(meta._exportedAt).toLocaleString()}\n`;
        msg += `• App version: ${meta._appVersion || 'unknown'}\n`;
        msg += `• Patients: ${meta._summary?.patients ?? '?'}\n`;
        msg += `• Slides: ${meta._summary?.slides ?? '?'}\n`;
        msg += `• Batches: ${meta._summary?.batches ?? '?'}\n\n`;
      } else {
        msg += '⚠️ Legacy backup (no metadata).\n\n';
      }
      msg += 'Continue?';
      if (!confirm(msg)) return;
      state = Object.assign({ patients: [], batches: [], seqPatient: 0, seqBatch: 0, protocol: null, settings: null, protocolVersion: 1 }, data);
      if (!Array.isArray(state.protocol) || !state.protocol.length) state.protocol = deepCopyProtocol(DEFAULT_PROTOCOL);
      if (!state.settings || !Array.isArray(state.settings.groupLabels)) state.settings = deepCopySettings(DEFAULT_SETTINGS);
      if (!Array.isArray(state.settings.groupDelays) ||
        state.settings.groupDelays.length !== state.settings.groupLabels.length) {
        state.settings.groupDelays = state.settings.groupLabels.map(() => 0);
      }
      if (typeof state.protocolVersion !== 'number') state.protocolVersion = 1;
      state.batches.forEach(b => {
        if (!Array.isArray(b.protocolSnapshot) || !b.protocolSnapshot.length) {
          b.protocolSnapshot = deepCopyProtocol(state.protocol);
          b.protocolVersion = state.protocolVersion;
        }
        if (!Array.isArray(b.stepLog)) b.stepLog = [];
      });
      save(); renderAll();
      toast('Backup restored');
    } catch (err) { toast('Invalid backup file'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function resetAll() {
  if (!confirm('Delete ALL patients (real + simulated), batches and scores? Cannot be undone.')) return;
  if (!confirm('Really sure? Export a JSON backup first if you need it.')) return;
  state = {
    patients: [], batches: [], seqPatient: 0, seqBatch: 0,
    protocol: deepCopyProtocol(DEFAULT_PROTOCOL),
    settings: deepCopySettings(DEFAULT_SETTINGS),
    protocolVersion: 1
  };
  selected.clear();
  expandedPatients.clear();
  expandedProtocols.clear();
  expandedSlideLists.clear();
  patientFilter = 'all';
  patientSort = 'newest';
  const sel = $('sortSelect');
  if (sel) sel.value = 'newest';
  save(); renderAll();
  toast('All data deleted');
}

/* ===================== CLOCKS ===================== */
function updateClocks() {
  const now = Date.now();

  document.querySelectorAll('[data-code]').forEach(el => {
    const s = findSlide(el.dataset.code);
    if (!s) return;

    if (el.classList.contains('slide-chip')) {
      const timeEl = el.querySelector('.chip-time');
      if (!timeEl) return;
      if (s.status === 'fixing') {
        const rem = s.fixEnd - now;
        if (rem > 0) {
          timeEl.textContent = fmt(rem);
          if (!el.classList.contains('s-fixing') && !el.classList.contains('s-ready')) {
            el.className = el.className.replace(/s-(?:pending|ready)/g, '').trim();
            if (!el.classList.contains('s-fixing')) el.classList.add('s-fixing');
          }
        } else {
          timeEl.textContent = 'READY';
          if (!el.classList.contains('s-ready')) {
            el.className = el.className.replace(/s-fixing|s-pending/g, '').trim();
            if (!el.classList.contains('s-ready')) el.classList.add('s-ready');
            if (!el.classList.contains('clickable')) el.classList.add('clickable');
          }
        }
      }
    } else if (el.classList.contains('cd')) {
      if (s.status !== 'fixing') { el.textContent = '—'; el.classList.remove('ready'); }
      else {
        const rem = s.fixEnd - now;
        el.textContent = rem > 0 ? fmt(rem) : 'READY';
        el.classList.toggle('ready', rem <= 0);
      }
    }
  });

  document.querySelectorAll('.patient-card[data-pid]').forEach(card => {
    const p = state.patients.find(x => x.id === card.dataset.pid);
    if (!p) return;
    const hasReady = p.slides.some(s => s.status === 'fixing' && now >= s.fixEnd);
    const hasActive = p.slides.some(s => s.status === 'fixing');
    card.classList.toggle('has-ready', hasReady);
    card.classList.toggle('has-active', hasActive && !hasReady);
  });

  document.querySelectorAll('.batchcd[data-batch]').forEach(el => {
    const b = findBatch(el.dataset.batch);
    if (!b || b.status !== 'running' || !b.stepRunning) return;
    const step = batchProtocol(b)[b.stepIndex];
    if (!step || step.sec <= 0) { el.textContent = '—'; el.classList.remove('ready'); return; }
    const rem = b.stepEnd - now;
    el.textContent = rem > 0 ? fmt(rem) : 'DONE';
    el.classList.toggle('ready', rem <= 0);
  });

  document.querySelectorAll('.barfill[data-bar]').forEach(el => {
    const b = findBatch(el.dataset.bar);
    if (!b || b.status !== 'running' || !b.stepRunning) { el.style.width = '0%'; return; }
    const step = batchProtocol(b)[b.stepIndex];
    if (!step || step.sec <= 0) { el.style.width = '100%'; return; }
    const pct = Math.min(100, Math.max(0, ((now - b.stepStart) / (step.sec * 1000)) * 100));
    el.style.width = pct + '%';
  });
}

setInterval(() => {
  const now = Date.now();
  let changed = false;

  allSlides().forEach(({ p, s }) => {
    if (s.status === 'fixing' && now >= s.fixEnd && !s.notified) {
      s.notified = true; changed = true;
      beep(3);
      toast(`⏰ ${s.code} (${fmtMin(s.fixMinutes)}) — take to empty container now`);
    }
  });

  state.batches.forEach(b => {
    const step = batchProtocol(b)[b.stepIndex];
    if (b.status === 'running' && b.stepRunning && b.stepEnd && now >= b.stepEnd && !b.notified && step && step.sec > 0) {
      b.notified = true; changed = true;
      beep(2);
      toast(`Batch ${b.id}: "${step.name}" complete`);
    }
  });

  if (changed) { save(); renderPatients(); renderFixationTab(); renderBatches(); renderDashboard(); }
  updateClocks();

  if ($('tab-fixation') && $('tab-fixation').classList.contains('active')) {
    renderNextPullBanner();
    renderTodaySchedule();
  }
  if ($('tab-timing') && $('tab-timing').classList.contains('active')) {
    renderTimingTab();
  }
}, 500);

/* ===================== RENDER ALL ===================== */
function renderAll() {
  renderDashboard();
  renderPatients();
  renderFixationTab();
  renderStaining();
  renderClearMountTab();
  renderScoring();
  renderTimingTab();
  updateSimStats();
  if ($('tab-settings') && $('tab-settings').classList.contains('active')) {
    openSettingsTab();
  }
  updateClocks();
}

/* ===================== BOOT ===================== */
load();
renderAll();