/*
 * Validation harness for index.html.
 * It reads the page, extracts the shipped <script id="seebeck-core"> block, runs it
 * in a VM sandbox and checks the physics against hand-computed cases, then sanity-checks
 * the markup (ids referenced from JS, balanced tags, no leftover build markers).
 *
 *   node seebeck.test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const MU = '\u00B5';           // micro sign
const DASH = '\u2014';         // em dash
let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; } else { fail++; failures.push(name + (detail ? ' -> ' + detail : '')); }
}
function near(name, got, want, tol = 1e-9) {
  const good = typeof want === 'number'
    ? (Number.isNaN(want) ? Number.isNaN(got) : Math.abs(got - want) <= Math.max(tol, Math.abs(want) * 1e-9))
    : false;
  ok(name, good, good ? '' : 'got ' + got + ', want ' + want);
}
function eq(name, got, want) { ok(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }

/* ---------- 1. extract + run the core ---------- */
const coreMatch = html.match(/<script id="seebeck-core">([\s\S]*?)<\/script>/);
ok('core script block exists', !!coreMatch);
const sandbox = vm.createContext({});
let C;
try {
  vm.runInContext(coreMatch[1], sandbox);
  C = sandbox.SeebeckCore;
} catch (e) {
  console.error('FATAL: core script failed to evaluate:', e.message);
  process.exit(1);
}
ok('core exposes an API', !!C && typeof C.model === 'function');

/* ---------- 2. syntax-check every script block ---------- */
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
eq('three script blocks found', scripts.length, 3);
scripts.forEach((src, i) => {
  let good = true, err = '';
  try { new vm.Script(src, { filename: 'inline-' + i + '.js' }); } catch (e) { good = false; err = e.message; }
  ok('script block ' + (i + 1) + ' parses', good, err);
});

/* Theme initializes before painting and tolerates unavailable storage. */
function initialTheme(saved, systemDark, storageBlocked = false) {
  const document = { documentElement: { dataset: {} } };
  vm.runInNewContext(scripts[0], {
    document,
    window: { matchMedia: () => ({ matches: systemDark }) },
    localStorage: { getItem() { if (storageBlocked) throw new Error('blocked'); return saved; } }
  });
  return document.documentElement.dataset.theme;
}
eq('theme follows light system', initialTheme(null, false), 'light');
eq('theme follows dark system', initialTheme(null, true), 'dark');
eq('saved light overrides dark system', initialTheme('light', true), 'light');
eq('saved dark overrides light system', initialTheme('dark', false), 'dark');
eq('invalid theme falls back to system', initialTheme('invalid', true), 'dark');
eq('blocked storage falls back to system', initialTheme(null, true, true), 'dark');

/* ---------- 3. temperature conversions ---------- */
near('0 C -> 273.15 K', C.toKelvin(0, 'C'), 273.15);
near('100 F -> 310.9277778 K', C.toKelvin(100, 'F'), 310.9277777777778);
near('273.15 K -> 0 C', C.fromKelvin(273.15, 'C'), 0);
near('373.15 K -> 212 F', C.fromKelvin(373.15, 'F'), 212);
near('Kelvin passthrough', C.toKelvin(500, 'K'), 500);
eq('1 K step = 1 C step', C.deltaToUnit(10, 'C'), 10);
eq('1 K step = 1.8 F step', C.deltaToUnit(10, 'F'), 18);
eq('comma decimal parses', C.parseNum('41,5'), 41.5);
eq('empty string is NaN', Number.isNaN(C.parseNum('')), true);

/* ---------- 4. V = N * S * dT ---------- */
const base = { mode: 'voltage', seebeck: '41', seebeckUnit: 'uV/K', n: '1', th: '100', tc: '25', unit: 'C' };
const r1 = C.model({ ...base, rint: '', rload: '', zt: '' });
ok('type K case is clean', r1.ok && r1.errors.length === 0, r1.errors.join(';'));
near('dT 100-25 C = 75 K', r1.dT, 75);
near('one couple = 3.075 mV', r1.vCouple, 3.075e-3);
near('total = 3.075 mV', r1.vTotal, 3.075e-3);

/* NIST spot check: type K, 0..100 C is 4.096 mV; the constant-S estimate must be close */
const rK = C.model({ ...base, tc: '0' });
near('type K 0->100 C ~ 4.1 mV (NIST 4.096)', rK.vTotal, 4.1e-3);
ok('constant-S estimate within 0.2% of NIST', Math.abs(rK.vTotal - 4.096e-3) / 4.096e-3 < 0.002, String(rK.vTotal));

/* thermopile scaling: 127 Bi2Te3 couples over 1 K */
const rP = C.model({ mode: 'voltage', seebeck: '420', seebeckUnit: 'uV/K', n: '127', th: '26', tc: '25', unit: 'C' });
near('127 couples x 420 uV/K x 1 K = 53.34 mV', rP.vTotal, 53.34e-3);

/* unit prefixes on S, and the three temperature units agree */
const rMv = C.model({ ...base, seebeck: '0.041', seebeckUnit: 'mV/K' });
near('mV/K same as uV/K', rMv.vTotal, 3.075e-3);
const rVK = C.model({ ...base, seebeck: '0.000041', seebeckUnit: 'V/K' });
near('V/K same as uV/K', rVK.vTotal, 3.075e-3);
const rF = C.model({ ...base, unit: 'F', th: '212', tc: '77' });
near('212/77 F gives 75 K', rF.dT, 75);
const rKel = C.model({ ...base, unit: 'K', th: '373.15', tc: '298.15' });
near('373.15/298.15 K gives 75 K', rKel.dT, 75);

/* polarity handling */
const rNeg = C.model({ ...base, th: '25', tc: '100' });
near('reversed gradient flips the sign', rNeg.vTotal, -3.075e-3);
const rN = C.model({ ...base, seebeck: '-215', th: '75', tc: '25' });
near('n-type leg over 50 K = -10.75 mV', rN.vTotal, -10.75e-3);
const rZero = C.model({ ...base, th: '25', tc: '25' });
near('no gradient, no voltage', rZero.vTotal, 0);

/* ---------- 5. the inverse solves ---------- */
const rDT = C.model({ mode: 'dT', seebeck: '41', seebeckUnit: 'uV/K', n: '1', tc: '25', unit: 'C', measured: '4.095', measuredUnit: 'mV' });
near('dT mode: 4.095 mV / 41 uV/K = 99.878 K', rDT.dT, 99.87804878048782);
near('dT mode implies the hot side', C.fromKelvin(rDT.ThK, 'C'), 124.87804878048782);
ok('dT mode round-trips the voltage', Math.abs(rDT.vTotal - 4.095e-3) < 1e-12, String(rDT.vTotal));

const rS = C.model({ mode: 'S', n: '1', th: '100', tc: '0', unit: 'C', measured: '4.095', measuredUnit: 'mV' });
near('S mode: 4.095 mV over 100 K = 40.95 uV/K', rS.S, 4.095e-5);
eq('S mode needs no coefficient input', rS.errors.length, 0);

const rU = C.model({ mode: 'S', n: '10', th: '100', tc: '0', unit: 'C', measured: '4.095', measuredUnit: 'mV' });
near('S mode divides by N', rU.S, 4.095e-6);

/* closed loop: forward -> measure -> back to S -> back to dT */
const v = r1.vTotal;
const backS = C.model({ mode: 'S', n: '1', th: '100', tc: '25', unit: 'C', measured: String(v), measuredUnit: 'V' });
near('round trip recovers S = 41 uV/K', backS.S, 41e-6);
const backDT = C.model({ mode: 'dT', seebeck: '41', seebeckUnit: 'uV/K', n: '1', tc: '25', unit: 'C', measured: String(v), measuredUnit: 'V' });
near('round trip recovers dT = 75 K', backDT.dT, 75);
/* ---------- 6. circuit model ---------- */
const cir = { mode: 'voltage', seebeck: '41', seebeckUnit: 'uV/K', n: '1', th: '100', tc: '0', unit: 'C', rint: '1', rload: '1' };
const rc = C.model(cir);
near('matched current = 2.05 mA', rc.current, 2.05e-3);
near('matched power = V^2/4R = 4.2025 uW', rc.pLoad, 4.2025e-6);
near('Pmax equals matched load power', rc.pMax, 4.2025e-6);
near('terminal voltage = V - I*Rint', rc.vTerminal, 4.1e-3 - 2.05e-3 * 1);
const rShort = C.model({ ...cir, rload: '0' });
near('short-circuit current = V/Rint', rShort.current, 4.1e-3);
eq('short circuit delivers no load power', rShort.pLoad, 0);
const rOpen = C.model({ ...cir, rload: '1e9' });
ok('high load drives the current towards zero', rOpen.current < 4.1e-12, String(rOpen.current));
const rNoR = C.model({ ...cir, rint: '', rload: '' });
ok('blank resistances disable the power results', Number.isNaN(rNoR.current) && Number.isNaN(rNoR.pMax));

/* ---------- 7. efficiency ---------- */
function eff(zt) {
  return C.model({ mode: 'voltage', seebeck: '41', seebeckUnit: 'uV/K', n: '1', th: '400', tc: '300', unit: 'K', zt: String(zt) });
}
const e1 = eff(1);
near('Carnot 300/400 K = 25 %', e1.etaCarnot, 0.25);
near('ZT=1 efficiency ~ 15.59 %', e1.etaTE, 0.25 * (Math.SQRT2 - 1) / (Math.SQRT2 - 0.75), 1e-12);
ok('TE efficiency stays below the Carnot limit', e1.etaTE > 0 && e1.etaTE < e1.etaCarnot);
ok('higher ZT gives higher efficiency', eff(3).etaTE > e1.etaTE && eff(100).etaTE > eff(3).etaTE);
ok('ZT=100 approaches Carnot', eff(100).etaTE > 0.9 * e1.etaCarnot, String(eff(100).etaTE));
ok('ZT=0 disables efficiency', Number.isNaN(eff(0).etaTE));
ok('efficiency uses the magnitude of the gradient',
   Math.abs(C.model({ mode: 'voltage', seebeck: '41', n: '1', th: '300', tc: '400', unit: 'K', zt: '1' }).etaTE - e1.etaTE) < 1e-15);

/* ---------- 8. input validation ---------- */
const bad1 = C.model({ ...base, th: '' });
ok('missing hot temp is flagged', !bad1.ok && bad1.errors.some(e => /hot-side/i.test(e)), bad1.errors.join(';'));
const bad2 = C.model({ ...base, th: '-300' });
ok('below absolute zero is flagged', bad2.errors.some(e => /absolute zero/i.test(e)), bad2.errors.join(';'));
const bad3 = C.model({ ...base, n: '0' });
ok('N=0 is flagged but clamped to 1', bad3.errors.some(e => /couples/i.test(e)) && bad3.n === 1, JSON.stringify(bad3.errors));
const bad4 = C.model({ mode: 'dT', seebeck: '0', n: '1', tc: '25', unit: 'C', measured: '4', measuredUnit: 'mV' });
ok('S=0 cannot be inverted for dT', bad4.errors.some(e => /non-zero/i.test(e)), bad4.errors.join(';'));
const bad5 = C.model({ mode: 'S', n: '1', th: '50', tc: '50', unit: 'C', measured: '4', measuredUnit: 'mV' });
ok('zero dT cannot be inverted for S', bad5.errors.some(e => /non-zero dT/i.test(e)), bad5.errors.join(';'));
const bad6 = C.model({ ...base, seebeck: 'abc' });
ok('non-numeric S is flagged', bad6.errors.some(e => /Seebeck/i.test(e)), bad6.errors.join(';'));
ok('fractional N rounds', C.model({ ...base, n: '12.4' }).n === 12);

/* ---------- 9. formatting ---------- */
eq('3.075e-3 V -> mV', C.fmtVolts(3.075e-3), '3.075 mV');
eq('4.1e-3 V -> mV', C.fmtVolts(4.1e-3), '4.1 mV');
eq('41e-6 V -> uV', C.fmtVolts(41e-6), '41 ' + MU + 'V');
eq('1e-9 V -> nV', C.fmtVolts(1e-9), '1 nV');
eq('0.999e-3 V picks uV', C.fmtVolts(0.999e-3), '999 ' + MU + 'V');
eq('1500 V -> kV', C.fmtVolts(1500), '1.5 kV');
eq('negative keeps the sign', C.fmtVolts(-3.075e-3), '-3.075 mV');
eq('zero volts -> V', C.fmtVolts(0), '0 V');
eq('NaN -> em dash', C.fmtVolts(NaN), DASH);
eq('1e-6 W -> uW', C.fmtWatts(1e-6), '1 ' + MU + 'W');
eq('2.5e-3 W -> mW', C.fmtWatts(2.5e-3), '2.5 mW');
eq('2.05e-3 A -> mA', C.fmtAmps(2.05e-3), '2.05 mA');
eq('15.59 % percent', C.fmtPercent(e1.etaTE), '15.6 %');
eq('NaN percent -> em dash', C.fmtPercent(NaN), DASH);
eq('sig trims trailing zeros', C.sig(0.0041, 4), '0.0041');
eq('sig rounds 1234.5 to 4 digits', C.sig(1234.5, 4), '1235');
/* ---------- 10. markup + wiring checks ---------- */
ok('doctype present', /^\s*<!DOCTYPE html>/i.test(html));
ok('no leftover build markers', !/<!--(CHUNK|SCRIPT|UI|CORE-PART|TEST-PART)/.test(html));
for (const tag of ['section', 'div', 'details', 'table', 'svg', 'script', 'aside', 'header', 'footer', 'html', 'body']) {
  const open = (html.match(new RegExp('<' + tag + '[ >]', 'g')) || []).length;
  const close = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
  ok('balanced <' + tag + '>', open === close, open + ' open vs ' + close + ' close');
}
ok('exactly one h1', (html.match(/<h1/g) || []).length === 1);
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const refs = new Set([
  ...[...html.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]),
  ...[...html.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1])
]);
const missing = [...refs].filter(id => !ids.has(id));
ok('every JS id reference exists in the markup', missing.length === 0, 'missing: ' + missing.join(', '));
const forAttrs = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map(m => m[1]);
ok('every label points at a real control', forAttrs.every(f => ids.has(f)), forAttrs.filter(f => !ids.has(f)).join(', '));
const dataS = [...html.matchAll(/data-s="(-?[\d.]+)"/g)].map(m => Number(m[1]));
ok('reference table rows carry numeric S values', dataS.length >= 12 && dataS.every(Number.isFinite), String(dataS.length));
const presets = [...html.matchAll(/<option value="(-?[\d.]+)"/g)].map(m => Number(m[1]));
ok('preset options are numeric', presets.length >= 14 && presets.every(Number.isFinite));
ok('no external resources referenced', !/(src|href)\s*=\s*["']https?:/i.test(html));
ok('JS field map matches markup ids', ['seebeck', 'seebeck-unit', 'couples', 'thot', 'tcold', 'tunit',
  'measured', 'measured-unit', 'rint', 'rload', 'zt', 'preset'].every(i => ids.has(i)));
const presetsFromTable = dataS.filter(s => !presets.includes(s));
ok('table rows all have a matching preset option', presetsFromTable.length === 0, presetsFromTable.join(', '));

/* ---------- 11. execute the real UI script against a small DOM stub ---------- */
class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.value = attrs.value !== undefined ? attrs.value : '';
    this._text = '';
    this._html = '';
    this.classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    this.style = {};
    this.disabled = false;
    this.open = false;
    this.handlers = {};
    this.children = [];
    this.parent = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  get className() { return [...this.classes].join(' '); }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const set = this.classes;
    return {
      toggle: (c, force) => { const want = force === undefined ? !set.has(c) : !!force; want ? set.add(c) : set.delete(c); },
      add: c => set.add(c),
      contains: c => set.has(c)
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  dispatch(type) { (this.handlers[type] || []).forEach(fn => fn.call(this, { type })); }
  closest(sel) { return this.parent && this.parent.classes.has(sel.replace('.', '')) ? this.parent : null; }
  select() {}
}

const dom = { els: new Map(), rows: [] };
for (const m of html.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
  const attrs = {};
  for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  const el = new El(m[1], attrs);
  dom.els.set(m[3], el);
}
/* row cells need a parent with class="row" so row() can hide them */
for (const id of ['o-dt', 'o-one', 'o-total', 'o-pol', 'o-s', 'o-i', 'o-p', 'o-pm', 'o-car', 'o-eff']) {
  const el = dom.els.get(id);
  if (el) el.parent = new El('div', { class: 'row' });
}
/* preset options + reference-table rows */
const presetEl = dom.els.get('preset');
presetEl.options = [...html.matchAll(/<option value="([^"]*)"/g)].map(m => ({ value: m[1] }));
for (const m of html.matchAll(/<tr class="pick" data-s="([^"]+)"/g)) dom.rows.push(new El('tr', { 'data-s': m[1] }));

const location = { href: 'file:///C:/seebeck/index.html', hash: '', pathname: '/C:/seebeck/index.html', search: '' };
const document = {
  documentElement: { dataset: {} },
  getElementById: id => dom.els.get(id),
  querySelectorAll: sel => (sel === '#ref-table tbody tr' ? dom.rows : []),
  createElement: tag => new El(tag),
  execCommand: () => true,
  body: { appendChild() {}, removeChild() {} }
};
const uiCtx = vm.createContext({
  document, location, SeebeckCore: C, console,
  history: { replaceState: (a, b, url) => { location.hash = url && url.startsWith('#') ? url.slice(1) : ''; } },
  navigator: {}, window: { scrollTo: () => {} }, setTimeout, clearTimeout
});
/* a <select> in a browser reports its selected option: mimic that before running */
const SELECT_DEFAULTS = { tunit: 'C', 'seebeck-unit': 'uV/K', 'measured-unit': 'mV', preset: '' };
ok('markup marks those options selected',
  /<option value="C" selected>/.test(html) && /<option value="uV\/K" selected>/.test(html) &&
  /<option value="mV" selected>/.test(html));
for (const [id, v] of Object.entries(SELECT_DEFAULTS)) { const e = dom.els.get(id); if (e) e.value = v; }
const appended = [];
document.body.appendChild = el => { appended.push(el); };
document.body.removeChild = () => {};

/* run all scripts in one context, exactly like the browser does */
let uiError = null;
try {
  scripts.forEach(src => vm.runInContext(src, uiCtx));
} catch (e) { uiError = e; }
ok('UI script runs without throwing', uiError === null,
  uiError && (uiError.message + ' / ' + String(uiError.stack || '').split('\n')[1]));

const E = id => dom.els.get(id);
const txt = id => String(E(id).textContent);
const vis = id => !E(id).parent.classes.has('hidden');

eq('theme starts light', txt('theme-label'), 'Light');
E('theme-toggle').dispatch('click');
eq('theme button enables dark mode', document.documentElement.dataset.theme, 'dark');
eq('theme button exposes dark state', E('theme-toggle').getAttribute('aria-pressed'), 'true');
eq('theme label updates', txt('theme-label'), 'Dark');
E('theme-toggle').dispatch('click');
eq('theme button returns to light', document.documentElement.dataset.theme, 'light');

/* default scenario: type K couple, 100 C vs 25 C */
ok('hero shows 3.075 mV', /3\.075/.test(E('hero').innerHTML) && /mV/.test(E('hero').innerHTML), E('hero').innerHTML);
eq('total EMF row', txt('o-total'), '3.075 mV');
eq('voltage per couple row', txt('o-one'), '3.075 mV');
eq('delta T row', txt('o-dt'), '75 K');
eq('coefficient row', txt('o-s'), '41 ' + MU + 'V/K');
ok('polarity says the hot side is positive', /\+ on the T/.test(txt('o-pol')), txt('o-pol'));
eq('preset auto-selects type K', E('preset').value, '41');
ok('power note mentions microwatts', txt('msg').includes(MU + 'W'), txt('msg'));
ok('diagram labels the gradient and EMF', txt('g-dt').includes('75 K') && txt('g-dt').includes('mV'), txt('g-dt'));
ok('efficiency row is visible with ZT=1', vis('o-eff') && txt('o-eff').endsWith('%'), txt('o-eff'));
ok('carnot row visible', vis('o-car'), txt('o-car'));
eq('no hash for an all-defaults state', location.hash, '');

/* reverse the gradient */
E('thot').value = '0';
E('thot').dispatch('input');
eq('negative delta T', txt('o-dt'), '-25 K');
eq('negative EMF', txt('o-total'), '-1.025 mV');
ok('negative EMF gets an explanatory note', /swap the leads/.test(txt('msg')), txt('msg'));
ok('polarity note mentions the reversed gradient', /gradient reversed/.test(txt('o-pol')), txt('o-pol'));
E('thot').value = '100';
E('thot').dispatch('input');

/* mode switch to dT (cold-junction compensation) */
E('m-dT').dispatch('click');
ok('dT mode hides the hot-side field', E('f-th').classes.has('hidden'));
ok('dT mode shows the measured-voltage field', !E('f-vmeas').classes.has('hidden'));
ok('hero shows the implied gradient', /99\.88/.test(E('hero').innerHTML), E('hero').innerHTML);
ok('mode is in the URL fragment', location.hash.includes('m=dT'), location.hash);
ok('hot side is marked as implied', /\(implied\)/.test(txt('tag-th')), txt('tag-th'));

/* mode switch to S */
E('m-S').dispatch('click');
ok('S mode hides the coefficient field', E('f-S').classes.has('hidden'));
ok('S mode shows both temperatures', !E('f-th').classes.has('hidden'));
ok('hero shows the derived coefficient', /54\.6/.test(E('hero').innerHTML), E('hero').innerHTML);

/* reference-table row click */
const nRow = dom.rows.find(r => r.getAttribute('data-s') === '-215');
nRow.handlers.click[0].call(nRow, {});
eq('table click sets the coefficient', E('seebeck').value, '-215');
eq('table click syncs the preset select', E('preset').value, '-215');
E('seebeck').value = '-100';
E('seebeck').dispatch('input');
eq('custom coefficient clears the preset', E('preset').value, '');

/* absolute-zero guard */
E('m-voltage').dispatch('click');
E('thot').value = '-300';
E('thot').dispatch('input');
ok('below absolute zero shows an error', /absolute zero/.test(txt('msg')) && E('msg').classes.has('err'), txt('msg'));
E('thot').value = '100';
E('thot').dispatch('input');

/* Fahrenheit + Kelvin paths */
E('seebeck').value = '41';
E('seebeck').dispatch('input');
E('tunit').value = 'F';
E('tunit').dispatch('change');
E('thot').value = '212';
E('tcold').value = '77';
E('tcold').dispatch('input');
eq('Fahrenheit delta T shows both units', txt('o-dt'), '75 K / 135 ' + String.fromCharCode(176) + 'F');
E('tunit').value = 'K';
E('tunit').dispatch('change');
E('thot').value = '373.15';
E('tcold').value = '298.15';
E('tcold').dispatch('input');
eq('Kelvin path gives the same EMF', txt('o-total'), '3.075 mV');

/* copy + reset */
E('copy').dispatch('click');
ok('results copied to a fallback textarea', appended.length === 1 && /Total EMF \(open ckt\): 3\.075 mV/.test(appended[0].value),
  appended.length ? appended[0].value.slice(0, 80) : 'nothing appended');
ok('copy reports success', /copied/.test(txt('status')), txt('status'));
ok('summary lists the coefficient and delta T', /Seebeck coefficient : 41 uV\/K/.test(appended[0].value) && /Delta T             : 75 K/.test(appended[0].value));
E('reset').dispatch('click');
eq('reset restores the coefficient', E('seebeck').value, '41');
eq('reset restores the unit', E('tunit').value, 'C');
ok('reset returns to voltage mode', E('f-vmeas').classes.has('hidden') && !E('f-th').classes.has('hidden'));
eq('reset clears the fragment', location.hash, '');

/* ---------- 12. stylesheet sanity + accordion alignment ---------- */
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
ok('style block found', css.length > 1000);
eq('css braces balanced', (css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
const summaryRule = css.match(/details\.adv > summary\{([^}]*)\}/);
ok('accordion summary is a flex row', !!summaryRule && /display:flex/.test(summaryRule[1]),
  summaryRule && summaryRule[1].replace(/\s+/g, ' '));
ok('accordion label text starts flush left (no hanging marker)',
  !!summaryRule && /list-style:none/.test(summaryRule[1]) && !/list-style-position/.test(css));
ok('native webkit marker suppressed', /details\.adv > summary::-webkit-details-marker\{display:none\}/.test(css));
ok('accordion label has breathing room around the divider',
  !!summaryRule && /padding:6px 0/.test(summaryRule[1]) && /padding-top:8px/.test(css));
ok('custom chevron defined for both states',
  /details\.adv > summary::after\{[^}]*rotate\(45deg\)/.test(css) && /details\.adv\[open\] > summary::after\{[^}]*rotate\(-135deg\)/.test(css));
ok('summary keeps a focus ring', /details\.adv > summary:focus-visible/.test(css));
/* the label column it must line up with */
ok('field labels share the same left content edge', /\.field > label,\.field \.lbl\{/.test(css));

/* ---------- report ---------- */



console.log('\n' + '='.repeat(58));
console.log('Seebeck calculator: ' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  x ' + f));
}
console.log('='.repeat(58));
process.exit(fail ? 1 : 0);

