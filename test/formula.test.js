// Vzorce tabuliek: výpočet, odkazy, rozsahy, funkcie, slovenský zápis, chyby a cykly.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../shared/formula');

const sheet = (cells, other) => {
  const map = {};
  Object.entries(cells).forEach(([a, v]) => { const p = F.parseRef(a); map[`${p.r}:${p.c}`] = v; });
  const out = F.computeAll(map, other, 'Hárok1');
  return (a) => { const v = out[`${F.parseRef(a).r}:${F.parseRef(a).c}`]; return F.isErr(v) ? v.code : v; };
};

describe('vzorce', () => {
  it('adresy a literály (slovenská desatinná čiarka, percentá)', () => {
    assert.equal(F.indexToCol(0), 'A');
    assert.equal(F.indexToCol(27), 'AB');
    assert.equal(F.colToIndex('AB'), 27);
    assert.deepEqual(F.parseRef('$C$12'), { r: 11, c: 2 });
    assert.equal(F.literal('1,5'), 1.5);
    assert.equal(F.literal('1 250'), 1250);
    assert.equal(F.literal('20 %'), 0.2);
    assert.equal(F.literal('Ahoj'), 'Ahoj');
  });

  it('aritmetika, priorita, odkazy, rozsahy a funkcie', () => {
    const v = sheet({ A1: '10', A2: '20', A3: '30,5', B1: '=A1+A2*2', B2: '=(A1+A2)*2', B3: '=SUM(A1:A3)', B4: '=AVERAGE(A1:A2)', B5: '=2^3^2', B6: '=-A1+5', B7: '="Spolu: "&B3', B8: '=ROUND(A3/3;2)', B9: '=MAX(A1:A3)-MIN(A1:A3)', B10: '=50%*A2' });
    assert.equal(v('B1'), 50);
    assert.equal(v('B2'), 60);
    assert.equal(v('B3'), 60.5);
    assert.equal(v('B4'), 15);
    assert.equal(v('B5'), 512);
    assert.equal(v('B6'), -5);
    assert.equal(v('B7'), 'Spolu: 60.5');
    assert.equal(v('B8'), 10.17);
    assert.equal(v('B9'), 20.5);
    assert.equal(v('B10'), 10);
  });

  it('podmienky, text, vyhľadávanie, slovenské názvy funkcií', () => {
    const v = sheet({
      A1: 'Jablko', A2: 'Hruška', A3: 'Jablko', B1: '3', B2: '5', B3: '4',
      C1: '=IF(B1>2;"veľa";"málo")', C2: '=KDE(B2<2;"málo";"veľa")', C3: '=SUMIF(A1:A3;"Jablko";B1:B3)', C4: '=COUNTIF(B1:B3;">3")',
      C5: '=VLOOKUP("hruška";A1:B3;2;FALSE)', C6: '=SÚČET(B1:B3)', C7: '=UPPER(LEFT(A2;3))', C8: '=IFERROR(1/0;"chyba")', C9: '=AND(B1>1;OR(B2=1;B3=4))',
      C10: '=SUM(1,5;2,5)', C11: '=SUM(1,2)', C12: '=AVERAGEIF(A1:A3;"Jab*";B1:B3)', C13: '=CONCAT(A1;" a ";A2)',
    });
    assert.equal(v('C1'), 'veľa');
    assert.equal(v('C2'), 'veľa');
    assert.equal(v('C3'), 7);
    assert.equal(v('C4'), 2);
    assert.equal(v('C5'), 5);
    assert.equal(v('C6'), 12);
    assert.equal(v('C7'), 'HRU');
    assert.equal(v('C8'), 'chyba');
    assert.equal(v('C9'), true);
    assert.equal(v('C10'), 4);
    assert.equal(v('C11'), 3);
    assert.equal(v('C12'), 3.5);
    assert.equal(v('C13'), 'Jablko a Hruška');
  });

  it('chyby, cyklus a odkaz na iný hárok', () => {
    const other = { Ceny: { '0:0': '100', '1:0': '=A1*2' } };
    const v = sheet({ A1: '=1/0', A2: '=NEEXISTUJE(1)', A3: '=A4', A4: '=A3', A5: '="a"*2', A6: '=Ceny!A2+1', A7: "='Ceny'!A1", A8: '=A1+1', A9: '=Zly!A1' }, other);
    assert.equal(v('A1'), '#DIV/0!');
    assert.equal(v('A2'), '#NAME?');
    assert.equal(v('A3'), '#CYCLE!');
    assert.equal(v('A5'), '#VALUE!');
    assert.equal(v('A6'), 201);
    assert.equal(v('A7'), 100);
    assert.equal(v('A8'), '#DIV/0!');
    assert.equal(v('A9'), '#REF!');
  });

  it('formátovanie po slovensky', () => {
    assert.equal(F.format(1234.5, 'number').replace(/\s/g, ' '), '1 234,50');
    assert.equal(F.format(0.256, 'percent').replace(/\s/g, ' '), '25,60 %');
    assert.match(F.format(19.9, 'currency'), /19,90\s€/);
    assert.equal(F.format(45000, 'date'), '15. 3. 2023');
    assert.equal(F.format(true), 'PRAVDA');
  });
});
