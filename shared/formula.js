'use strict';
/**
 * Vzorce tabuliek Neoworkly (vlastný ľahký výpočet, bez závislostí; beží v prehliadači aj na serveri).
 * Podporuje: + - * / ^ & porovnania, odkazy A1 / $A$1 / Hárok!A1, rozsahy A1:B5, reťazce "…", TRUE/FALSE
 * a funkcie nižšie (aj slovenské názvy ako v Exceli: SÚČET, PRIEMER, KDE…).
 * Oddeľovač argumentov ; alebo , (ak vzorec obsahuje ;, čiarka je desatinná – ako v slovenskom Exceli).
 */

const ERR = { REF: '#REF!', DIV0: '#DIV/0!', NAME: '#NAME?', VALUE: '#VALUE!', CYCLE: '#CYCLE!', NA: '#N/A', NUM: '#NUM!' };
class FErr { constructor(code) { this.code = code; } toString() { return this.code; } }
const isErr = v => v instanceof FErr;

/* ── Adresy ── */
function colToIndex(s) { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function indexToCol(i) { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
const addr = (r, c) => `${indexToCol(c)}${r + 1}`;
function parseRef(s) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,6})$/.exec(s);
  return m ? { r: Number(m[2]) - 1, c: colToIndex(m[1]) } : null;
}

/* ── Lexer ── */
function tokenize(src, argSep, decimalComma) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let j = i + 1, s = '';
      while (j < src.length) { if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += src[j++]; }
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    const num = (decimalComma ? /^\d+(?:,\d+)?(?:[eE][+-]?\d+)?%?/ : /^\d*\.?\d+(?:[eE][+-]?\d+)?%?/).exec(src.slice(i));
    if (num && /\d/.test(ch) || (num && ch === '.' && !decimalComma)) {
      let txt = num[0]; let pct = false;
      if (txt.endsWith('%')) { pct = true; txt = txt.slice(0, -1); }
      let v = Number(txt.replace(',', '.'));
      if (pct) v /= 100;
      out.push({ t: 'num', v }); i += num[0].length; continue;
    }
    // odkaz / rozsah / názov funkcie (aj s diakritikou a hárkom: 'Hárok 2'!A1 alebo Hárok2!A1)
    let m = /^(?:'([^']+)'|([\p{L}_][\p{L}\p{N}_.]*))!(\$?[A-Za-z]{1,3}\$?\d{1,6})(?::(\$?[A-Za-z]{1,3}\$?\d{1,6}))?/u.exec(src.slice(i));
    if (m) { out.push({ t: 'ref', sheet: m[1] || m[2], a: m[3], b: m[4] }); i += m[0].length; continue; }
    m = /^(\$?[A-Za-z]{1,3}\$?\d{1,6})(?::(\$?[A-Za-z]{1,3}\$?\d{1,6}))?(?![\p{L}\p{N}_(])/u.exec(src.slice(i));
    if (m) { out.push({ t: 'ref', a: m[1], b: m[2] }); i += m[0].length; continue; }
    m = /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(src.slice(i));
    if (m) { out.push({ t: 'name', v: m[0].toUpperCase() }); i += m[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '<>'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>()'.includes(ch)) { out.push({ t: ch === '(' || ch === ')' ? ch : 'op', v: ch }); i++; continue; }
    if (ch === argSep) { out.push({ t: 'sep' }); i++; continue; }
    if (ch === ';' || ch === ',') { out.push({ t: 'sep' }); i++; continue; }
    throw new FErr(ERR.NAME);
  }
  return out;
}

/* ── Parser (rekurzívny zostup) ── */
function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const eat = t => { const x = tokens[p]; if (!x || (t && x.t !== t)) throw new FErr(ERR.VALUE); p++; return x; };
  const PREC = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  function primary() {
    const x = peek();
    if (!x) throw new FErr(ERR.VALUE);
    if (x.t === 'op' && (x.v === '-' || x.v === '+')) { p++; const e = expr(5); return x.v === '-' ? { k: 'neg', e } : e; }
    if (x.t === 'num') { p++; return { k: 'lit', v: x.v }; }
    if (x.t === 'str') { p++; return { k: 'lit', v: x.v }; }
    if (x.t === 'ref') { p++; return { k: 'ref', sheet: x.sheet, a: x.a, b: x.b }; }
    if (x.t === '(') { p++; const e = expr(0); eat(')'); return e; }
    if (x.t === 'name') {
      p++;
      if (peek() && peek().t === '(') {
        p++;
        const args = [];
        if (peek() && peek().t !== ')') {
          for (;;) {
            if (peek() && (peek().t === 'sep' || peek().t === ')')) args.push({ k: 'lit', v: '' });
            else args.push(expr(0));
            if (peek() && peek().t === 'sep') { p++; continue; }
            break;
          }
        }
        eat(')');
        return { k: 'fn', name: x.v, args };
      }
      if (x.v === 'TRUE' || x.v === 'PRAVDA') return { k: 'lit', v: true };
      if (x.v === 'FALSE' || x.v === 'NEPRAVDA') return { k: 'lit', v: false };
      throw new FErr(ERR.NAME);
    }
    throw new FErr(ERR.VALUE);
  }
  function expr(min) {
    let left = primary();
    for (;;) {
      const x = peek();
      if (!x || x.t !== 'op' || PREC[x.v] === undefined || PREC[x.v] < min) break;
      p++;
      const right = expr(x.v === '^' ? PREC[x.v] : PREC[x.v] + 1);
      left = { k: 'bin', op: x.v, l: left, r: right };
    }
    return left;
  }
  const ast = expr(0);
  if (p < tokens.length) throw new FErr(ERR.VALUE);
  return ast;
}

/* ── Hodnoty ── */
/** Text z bunky → hodnota (číslo so slovenskou desatinnou čiarkou, %, bool). */
function literal(raw) {
  if (raw === undefined || raw === null) return '';
  const s = String(raw).trim();
  if (s === '') return '';
  if (/^-?\d+(?:[.,]\d+)?$/.test(s.replace(/\s/g, ''))) return Number(s.replace(/\s/g, '').replace(',', '.'));
  if (/^-?\d+(?:[.,]\d+)?\s?%$/.test(s)) return Number(s.replace(/[\s%]/g, '').replace(',', '.')) / 100;
  if (/^(TRUE|PRAVDA)$/i.test(s)) return true;
  if (/^(FALSE|NEPRAVDA)$/i.test(s)) return false;
  return String(raw);
}
const num = v => {
  if (isErr(v)) throw v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === '' || v === null || v === undefined) return 0;
  const n = literal(v);
  if (typeof n === 'number') return n;
  throw new FErr(ERR.VALUE);
};
const str = v => { if (isErr(v)) throw v; if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'; if (typeof v === 'number') return String(Math.round(v * 1e10) / 1e10); return String(v ?? ''); };
const bool = v => { if (isErr(v)) throw v; if (typeof v === 'boolean') return v; if (typeof v === 'number') return v !== 0; if (/^(TRUE|PRAVDA)$/i.test(String(v))) return true; if (/^(FALSE|NEPRAVDA)$/i.test(String(v)) || v === '') return false; throw new FErr(ERR.VALUE); };
const flat = args => args.flatMap(a => (Array.isArray(a) ? a.flat(Infinity) : [a]));
const numbersOf = args => flat(args).filter(v => { if (isErr(v)) throw v; return typeof v === 'number'; });

/** Podmienka ako v COUNTIF: ">5", "<>a", "=x", "text*" */
function matcher(crit) {
  if (typeof crit === 'number') return v => v === crit || (typeof v === 'string' && literal(v) === crit);
  const s = String(crit);
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(s);
  const op = m[1] || '=';
  const rhsRaw = m[2];
  const rhs = literal(rhsRaw);
  if (typeof rhs === 'number' && op !== '=' && op !== '<>') return v => typeof v === 'number' && ({ '<': v < rhs, '>': v > rhs, '<=': v <= rhs, '>=': v >= rhs }[op]);
  const re = new RegExp(`^${String(rhsRaw).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  const eq = v => (typeof rhs === 'number' ? num(v === '' ? NaN : v) === rhs : re.test(str(v)));
  return op === '<>' ? v => { try { return !eq(v); } catch { return true; } } : v => { try { return eq(v); } catch { return false; } };
}

const round = (n, d, mode) => { const f = 10 ** d; const x = n * f; return (mode === 'up' ? Math.sign(x) * Math.ceil(Math.abs(x) - 1e-9) : mode === 'down' ? Math.trunc(x) : Math.round(x + Math.sign(x) * 1e-9)) / f; };

const FN = {
  SUM: a => numbersOf(a).reduce((s, x) => s + x, 0),
  AVERAGE: a => { const n = numbersOf(a); if (!n.length) throw new FErr(ERR.DIV0); return n.reduce((s, x) => s + x, 0) / n.length; },
  MIN: a => { const n = numbersOf(a); return n.length ? Math.min(...n) : 0; },
  MAX: a => { const n = numbersOf(a); return n.length ? Math.max(...n) : 0; },
  COUNT: a => flat(a).filter(v => typeof v === 'number').length,
  COUNTA: a => flat(a).filter(v => v !== '' && v !== null && v !== undefined).length,
  COUNTBLANK: a => flat(a).filter(v => v === '' || v === null || v === undefined).length,
  IF: (a, raw) => (bool(a[0]) ? (a.length > 1 ? a[1] : true) : (a.length > 2 ? a[2] : false)),
  IFERROR: a => (isErr(a[0]) ? a[1] : a[0]),
  AND: a => flat(a).every(bool),
  OR: a => flat(a).some(bool),
  NOT: a => !bool(a[0]),
  ROUND: a => round(num(a[0]), num(a[1] ?? 0)),
  ROUNDUP: a => round(num(a[0]), num(a[1] ?? 0), 'up'),
  ROUNDDOWN: a => round(num(a[0]), num(a[1] ?? 0), 'down'),
  INT: a => Math.floor(num(a[0])),
  ABS: a => Math.abs(num(a[0])),
  SQRT: a => { const n = num(a[0]); if (n < 0) throw new FErr(ERR.NUM); return Math.sqrt(n); },
  POWER: a => num(a[0]) ** num(a[1]),
  MOD: a => { const d = num(a[1]); if (d === 0) throw new FErr(ERR.DIV0); const n = num(a[0]); return n - d * Math.floor(n / d); },
  CONCAT: a => flat(a).map(str).join(''),
  LEN: a => str(a[0]).length,
  UPPER: a => str(a[0]).toUpperCase(),
  LOWER: a => str(a[0]).toLowerCase(),
  TRIM: a => str(a[0]).trim().replace(/\s+/g, ' '),
  LEFT: a => str(a[0]).slice(0, a.length > 1 ? num(a[1]) : 1),
  RIGHT: a => { const s = str(a[0]); const n = a.length > 1 ? num(a[1]) : 1; return n ? s.slice(-n) : ''; },
  MID: a => str(a[0]).substr(num(a[1]) - 1, num(a[2])),
  TODAY: () => { const d = new Date(); return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000); },
  SUMIF: a => { const crit = matcher(a[1]); const range = flat([a[0]]); const sum = a[2] !== undefined ? flat([a[2]]) : range; return range.reduce((s, v, i) => (crit(v) && typeof sum[i] === 'number' ? s + sum[i] : s), 0); },
  COUNTIF: a => { const crit = matcher(a[1]); return flat([a[0]]).filter(crit).length; },
  AVERAGEIF: a => { const crit = matcher(a[1]); const range = flat([a[0]]); const vals = a[2] !== undefined ? flat([a[2]]) : range; const n = range.map((v, i) => (crit(v) && typeof vals[i] === 'number' ? vals[i] : null)).filter(x => x !== null); if (!n.length) throw new FErr(ERR.DIV0); return n.reduce((s, x) => s + x, 0) / n.length; },
  VLOOKUP: a => {
    const table = a[1];
    if (!Array.isArray(table)) throw new FErr(ERR.VALUE);
    const col = num(a[2]) - 1;
    const exact = a.length < 4 || !bool(a[3]);
    const key = a[0];
    if (col < 0 || col >= (table[0] || []).length) throw new FErr(ERR.REF);
    if (exact) {
      const row = table.find(r => (typeof key === 'number' ? literal(r[0]) === key : str(r[0]).toLowerCase() === str(key).toLowerCase()));
      if (!row) throw new FErr(ERR.NA);
      return row[col];
    }
    let found = null;
    for (const r of table) { if (num(r[0]) <= num(key)) found = r; else break; }
    if (!found) throw new FErr(ERR.NA);
    return found[col];
  },
};
// slovenské názvy funkcií (Excel v slovenčine)
Object.assign(FN, { SÚČET: FN.SUM, SUCET: FN.SUM, PRIEMER: FN.AVERAGE, POČET: FN.COUNT, POCET: FN.COUNT, POČET2: FN.COUNTA, KDE: FN.IF, AK: FN.IF, ZAOKRÚHLIŤ: FN.ROUND, ZAOKRUHLIT: FN.ROUND, CONCATENATE: FN.CONCAT, DNES: FN.TODAY, SUMIF: FN.SUMIF, COUNTIF: FN.COUNTIF });
const LAZY = new Set(['IF', 'KDE', 'AK', 'IFERROR']);

/**
 * Vypočíta hodnotu bunky.
 * @param {string} raw text bunky (vzorec začína „=“)
 * @param {(sheet:string|undefined, r:number, c:number) => any} get hodnota inej bunky (už vypočítaná)
 */
function evaluate(raw, get) {
  const s = String(raw ?? '');
  if (!s.startsWith('=') || s.length < 2) return literal(s);
  try {
    const src = s.slice(1);
    const semicolon = src.replace(/"(?:[^"]|"")*"/g, '').includes(';');
    const ast = parse(tokenize(src, semicolon ? ';' : ',', semicolon));
    const v = run(ast, get);
    if (Array.isArray(v)) return v[0]?.[0] ?? '';
    if (typeof v === 'number' && !Number.isFinite(v)) return new FErr(ERR.DIV0);
    return v;
  } catch (e) {
    if (isErr(e)) return e;
    return new FErr(ERR.VALUE);
  }
}

function run(n, get) {
  switch (n.k) {
    case 'lit': return n.v;
    case 'neg': return -num(run(n.e, get));
    case 'ref': {
      const a = parseRef(n.a);
      if (!a) throw new FErr(ERR.REF);
      if (!n.b) { const v = get(n.sheet, a.r, a.c); if (isErr(v)) throw v; return v; }
      const b = parseRef(n.b);
      if (!b) throw new FErr(ERR.REF);
      const rows = [];
      for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
        const row = [];
        for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) row.push(get(n.sheet, r, c));
        rows.push(row);
      }
      if (rows.length * (rows[0] || []).length > 200000) throw new FErr(ERR.REF);
      return rows;
    }
    case 'bin': {
      const l = run(n.l, get), r = run(n.r, get);
      const L = Array.isArray(l) ? l[0]?.[0] : l, R = Array.isArray(r) ? r[0]?.[0] : r;
      switch (n.op) {
        case '+': return num(L) + num(R);
        case '-': return num(L) - num(R);
        case '*': return num(L) * num(R);
        case '/': { const d = num(R); if (d === 0) throw new FErr(ERR.DIV0); return num(L) / d; }
        case '^': return num(L) ** num(R);
        case '&': return str(L) + str(R);
        default: {
          const cmp = (typeof L === 'number' || typeof L === 'boolean') && (typeof R === 'number' || typeof R === 'boolean')
            ? num(L) - num(R) : str(L).toLowerCase().localeCompare(str(R).toLowerCase(), 'sk');
          return { '=': cmp === 0, '<>': cmp !== 0, '<': cmp < 0, '>': cmp > 0, '<=': cmp <= 0, '>=': cmp >= 0 }[n.op];
        }
      }
    }
    case 'fn': {
      const f = FN[n.name];
      if (!f) throw new FErr(ERR.NAME);
      if (LAZY.has(n.name)) {
        if (n.name === 'IFERROR') { let v; try { v = run(n.args[0], get); } catch (e) { if (isErr(e)) return run(n.args[1] ?? { k: 'lit', v: '' }, get); throw e; } return isErr(v) ? run(n.args[1], get) : v; }
        const cond = bool(run(n.args[0], get));
        if (cond) return n.args.length > 1 ? run(n.args[1], get) : true;
        return n.args.length > 2 ? run(n.args[2], get) : false;
      }
      return f(n.args.map(a => run(a, get)));
    }
    default: throw new FErr(ERR.VALUE);
  }
}

/**
 * Výpočet celého hárku: cells = { 'r:c': raw } → { 'r:c': hodnota }. Cykly vrátia #CYCLE!.
 * sheets = { menoHárku: cells } pre odkazy na iné hárky (voliteľné).
 */
function computeAll(cells, sheets = {}, current) {
  const cache = new Map();
  const stack = new Set();
  const all = { ...sheets, [current ?? '']: cells };
  function value(sheet, r, c) {
    const name = sheet === undefined ? (current ?? '') : Object.keys(all).find(k => k.toLowerCase() === String(sheet).toLowerCase());
    if (name === undefined) throw new FErr(ERR.REF);
    const key = `${name}\u0000${r}:${c}`;
    if (cache.has(key)) return cache.get(key);
    if (stack.has(key)) return new FErr(ERR.CYCLE);
    stack.add(key);
    const v = evaluate(all[name][`${r}:${c}`], (s, rr, cc) => value(s ?? (name === (current ?? '') ? undefined : name), rr, cc));
    stack.delete(key);
    cache.set(key, v);
    return v;
  }
  const out = {};
  for (const k of Object.keys(cells)) { const [r, c] = k.split(':').map(Number); out[k] = value(undefined, r, c); }
  return out;
}

/** Zobrazenie hodnoty podľa formátu: general | number | percent | currency | date. */
function format(v, fmt, decimals) {
  if (isErr(v)) return v.code;
  if (typeof v === 'boolean') return v ? 'PRAVDA' : 'NEPRAVDA';
  if (typeof v !== 'number') return String(v ?? '');
  const d = decimals ?? (fmt === 'general' || !fmt ? undefined : 2);
  const nf = (o) => new Intl.NumberFormat('sk-SK', o).format(v);
  if (fmt === 'percent') return new Intl.NumberFormat('sk-SK', { style: 'percent', minimumFractionDigits: d ?? 0, maximumFractionDigits: d ?? 2 }).format(v);
  if (fmt === 'currency') return nf({ style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d });
  if (fmt === 'number') return nf({ minimumFractionDigits: d, maximumFractionDigits: d });
  if (fmt === 'date') { const t = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000); return t.toLocaleDateString('sk-SK', { timeZone: 'UTC' }); }
  return nf({ maximumFractionDigits: 10 });
}

module.exports = { ERR, FErr, isErr, colToIndex, indexToCol, addr, parseRef, literal, evaluate, computeAll, format, FUNCTIONS: Object.keys(FN) };
