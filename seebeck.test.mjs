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
eq('two script blocks found', scripts.length, 2);
scripts.forEach((src, i) => {
  let good = true, err = '';
  try { new vm.Script(src, { filename: 'inline-' + i + '.js' }); } catch (e) { good = false; err = e.message; }
  ok('script block ' + (i + 1) + ' parses', good, err);
});

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
console.log('...');
