// Word (.docx) pre Dokumenty: export blokov BlockNote cez knižnicu docx (MIT), import cez mammoth (BSD-2) → HTML → bloky.
// Načítava sa až pri použití (dynamický import z editora).
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType,
  AlignmentType, LevelFormat, BorderStyle, ShadingType,
} from 'docx';
import mammoth from 'mammoth';

const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };
const HEX = c => (/^#?[0-9a-f]{6}$/i.test(c || '') ? c.replace('#', '') : undefined);
const COLORS = { gray: '9B9A97', brown: '64473A', red: 'E03E3E', orange: 'D9730D', yellow: 'DFAB01', green: '4D6461', blue: '0B6E99', purple: '6940A5', pink: 'AD1A72' };

/** Vložený obsah (text so štýlmi, odkazy) → runy pre docx. */
function runs(content = []) {
  const out = [];
  for (const c of [].concat(content)) {
    if (typeof c === 'string') { out.push(new TextRun(c)); continue; }
    if (c.type === 'link') {
      out.push(new ExternalHyperlink({ link: c.href, children: (c.content || []).map(x => new TextRun({ text: x.text, style: 'Hyperlink', ...style(x.styles) })) }));
      continue;
    }
    if (c.type === 'text') {
      c.text.split('\n').forEach((part, i) => out.push(new TextRun({ text: part, break: i ? 1 : undefined, ...style(c.styles) })));
    }
  }
  return out;
}
function style(s = {}) {
  return {
    bold: !!s.bold || undefined, italics: !!s.italic || undefined, strike: !!s.strike || undefined,
    underline: s.underline ? {} : undefined, font: s.code ? 'Consolas' : undefined,
    color: COLORS[s.textColor] || HEX(s.textColor),
    shading: s.backgroundColor && s.backgroundColor !== 'default' ? { type: ShadingType.CLEAR, fill: COLORS[s.backgroundColor] ? `${COLORS[s.backgroundColor]}33`.slice(0, 6) : 'FFF59D' } : undefined,
  };
}

/** Bloky BlockNote → odseky/tabuľky docx (vnorené bloky = odsadenie zoznamu). */
function blocks(list, level = 0, out = []) {
  for (const b of list) {
    const p = b.props || {};
    const alignment = ALIGN[p.textAlignment];
    switch (b.type) {
      case 'heading':
        out.push(new Paragraph({ heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][(p.level || 1) - 1] || HeadingLevel.HEADING_3, alignment, children: runs(b.content) }));
        break;
      case 'bulletListItem':
        out.push(new Paragraph({ numbering: { reference: 'nw-bullets', level: Math.min(level, 8) }, alignment, children: runs(b.content) }));
        break;
      case 'numberedListItem':
        out.push(new Paragraph({ numbering: { reference: 'nw-numbers', level: Math.min(level, 8) }, alignment, children: runs(b.content) }));
        break;
      case 'checkListItem':
        out.push(new Paragraph({ indent: { left: 360 * (level + 1) }, children: [new TextRun(p.checked ? '☑ ' : '☐ '), ...runs(b.content)] }));
        break;
      case 'quote':
        out.push(new Paragraph({ indent: { left: 567 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: '9B8CFF', space: 8 } }, children: runs(b.content).map(r => r) }));
        break;
      case 'codeBlock':
        String((b.content || []).map(x => x.text || '').join('')).split('\n').forEach(line => out.push(new Paragraph({ shading: { type: ShadingType.CLEAR, fill: 'F3F4F6' }, children: [new TextRun({ text: line, font: 'Consolas', size: 20 })] })));
        break;
      case 'table': {
        const rows = (b.content?.rows || []).map(r => new TableRow({ children: r.cells.map(cell => new TableCell({ children: [new Paragraph({ children: runs(Array.isArray(cell) ? cell : cell.content) })] })) }));
        if (rows.length) out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        break;
      }
      case 'image':
        out.push(new Paragraph({ children: [new ExternalHyperlink({ link: p.url || '', children: [new TextRun({ text: p.caption || p.name || 'Obrázok', style: 'Hyperlink' })] })] }));
        break;
      default:
        out.push(new Paragraph({ alignment, children: runs(b.content) }));
    }
    if (b.children?.length) blocks(b.children, level + 1, out);
  }
  return out;
}

export async function toDocx(title, documentBlocks) {
  const levels = fmt => Array.from({ length: 9 }, (_, i) => ({ level: i, format: fmt, text: fmt === LevelFormat.BULLET ? ['•', '◦', '▪'][i % 3] : `%${i + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } } }));
  const doc = new Document({
    title, creator: 'Neoworkly',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: [{ reference: 'nw-bullets', levels: levels(LevelFormat.BULLET) }, { reference: 'nw-numbers', levels: levels(LevelFormat.DECIMAL) }] },
    sections: [{ children: blocks(documentBlocks) }],
  });
  return Packer.toBlob(doc);
}

/** .docx → HTML (mammoth) – editor ho prevedie na bloky cez tryParseHTMLToBlocks. */
export async function fromDocx(arrayBuffer) {
  const r = await mammoth.convertToHtml({ arrayBuffer }, { convertImage: mammoth.images.imgElement(img => img.read('base64').then(data => ({ src: `data:${img.contentType};base64,${data}` }))) });
  return r.value;
}
