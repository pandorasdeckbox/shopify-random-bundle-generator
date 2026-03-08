/**
 * DOCX Generator - creates a printable packing slip from bundle data.
 * Uses the 'docx' npm package (pure JS, no LibreOffice required).
 * Designed to fit on one sheet of paper.
 *
 * Also supports template-based generation via docxtemplater.
 * Upload a .docx template with {placeholders} in the Settings tab.
 *
 * Available placeholders:
 *   {customer_name}  {date}  {bundle_type}  {pack_count}
 *   {total_retail}   {target_price}  {margin_percent}  {margin_dollars}
 *   {d20_roll}       {d20_result}    {dry_run_label}
 *   Loop: {#packs}  {pack_num}  {pack_name}  {pack_type}  {pack_price}  {/packs}
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  HeadingLevel,
  ShadingType,
  VerticalAlign,
  convertInchesToTwip,
} from 'docx';

const BORDER_NONE = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};

const BORDER_SINGLE = {
  top: { style: BorderStyle.SINGLE, size: 4, color: '333333' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: '333333' },
  left: { style: BorderStyle.SINGLE, size: 4, color: '333333' },
  right: { style: BorderStyle.SINGLE, size: 4, color: '333333' },
};

function headerCell(text, shade = '1a1a2e') {
  return new TableCell({
    borders: BORDER_NONE,
    shading: { type: ShadingType.SOLID, color: shade },
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 20 })],
    })],
  });
}

function dataCell(text, bold = false, center = false) {
  return new TableCell({
    borders: BORDER_NONE,
    children: [new Paragraph({
      alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), bold, size: 20 })],
    })],
  });
}

function divider() {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '1a1a2e' } },
    children: [],
    spacing: { after: 120 },
  });
}

/**
 * Generate a packing slip DOCX buffer from bundle data.
 *
 * @param {Object} bundleData  - result from bundle generator
 * @param {string} customerName
 * @param {string} bundleType  - 'Chaos Club', 'Advent Calendar', 'Chaos Draft Kit'
 * @param {boolean} dryRun
 * @returns {Promise<Buffer>}
 */
export async function generateBundleDocx(bundleData, customerName = 'Walk-in', bundleType = 'Chaos Club', dryRun = false) {
  const { packs, targetPrice, metrics, d20Result } = bundleData;

  // Split packs into collector vs regular for display
  const collectorPacks = packs.filter(p => p.is_collector);
  const regularPacks = packs.filter(p => !p.is_collector);
  const orderedPacks = [...collectorPacks, ...regularPacks]; // collector first

  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const showD20 = bundleType === 'Chaos Club' && d20Result && d20Result.roll !== null;

  // ── Header ────────────────────────────────────────────────────────────────
  const headerTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders: BORDER_NONE,
            shading: { type: ShadingType.SOLID, color: '1a1a2e' },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: "PANDORA'S DECK BOX", bold: true, color: 'FFFFFF', size: 32 })],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: bundleType.toUpperCase() + ' — PACK LIST', color: 'e94560', size: 24, bold: true })],
              }),
            ],
          }),
        ],
      }),
    ],
  });

  // ── Info Row ──────────────────────────────────────────────────────────────
  const infoRows = [
    new TableRow({
      children: [
        headerCell('Customer'),
        dataCell(customerName, true),
        headerCell('Date'),
        dataCell(date),
      ],
    }),
    new TableRow({
      children: [
        headerCell('Bundle Type'),
        dataCell(bundleType),
        headerCell('Pack Count'),
        dataCell(String(packs.length), true, true),
      ],
    }),
  ];

  if (showD20) {
    const roll = d20Result.roll;
    const rollText = d20Result.upgraded ? `${roll} ★ UPGRADE!` : String(roll);
    const rollColor = d20Result.upgraded ? 'e94560' : '000000';
    infoRows.push(new TableRow({
      children: [
        headerCell('D20 Roll'),
        new TableCell({
          borders: BORDER_NONE,
          columnSpan: 3,
          children: [new Paragraph({
            children: [new TextRun({ text: rollText, bold: d20Result.upgraded, color: rollColor, size: 24 })],
          })],
        }),
      ],
    }));

    if (d20Result.upgraded) {
      infoRows.push(new TableRow({
        children: [
          headerCell('Upgrade'),
          new TableCell({
            borders: BORDER_NONE,
            columnSpan: 3,
            children: [new Paragraph({
              children: [new TextRun({ text: `${d20Result.upgradedFrom} → ${d20Result.upgradedTo}`, italic: true, size: 18 })],
            })],
          }),
        ],
      }));
    }
  }

  const infoTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: infoRows,
  });

  // ── Pack List ─────────────────────────────────────────────────────────────
  const packRows = [
    new TableRow({
      children: [
        headerCell('#', '1a1a2e'),
        headerCell('Pack Name', '1a1a2e'),
        headerCell('Retail', '1a1a2e'),
      ],
    }),
  ];

  for (let i = 0; i < orderedPacks.length; i++) {
    const pack = orderedPacks[i];
    const fullName = pack.product_title + (pack.variant_title ? ` – ${pack.variant_title}` : '');
    const displayName = pack.is_collector ? `⭐ ${fullName}  [COLLECTOR]` : fullName;
    const shade = i % 2 === 0 ? 'f9f9f9' : 'ffffff';

    packRows.push(new TableRow({
      children: [
        new TableCell({
          borders: BORDER_NONE,
          shading: { type: ShadingType.SOLID, color: shade },
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: String(i + 1), bold: pack.is_collector, size: 18 })],
          })],
        }),
        new TableCell({
          borders: BORDER_NONE,
          shading: { type: ShadingType.SOLID, color: shade },
          children: [new Paragraph({
            children: [new TextRun({ text: displayName, bold: pack.is_collector, size: 18 })],
          })],
        }),
        new TableCell({
          borders: BORDER_NONE,
          shading: { type: ShadingType.SOLID, color: shade },
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: `$${pack.price.toFixed(2)}`, size: 18 })],
          })],
        }),
      ],
    }));
  }

  const packTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: packRows,
    columnWidths: [600, 7200, 1200],
  });

  // ── Metrics Row ───────────────────────────────────────────────────────────
  const marginOk = metrics.margin_percent >= 10;
  const metricsRows = [
    new TableRow({
      children: [
        headerCell('Total Retail', '2d2d44'),
        dataCell(`$${metrics.total_retail.toFixed(2)}`, true, true),
        headerCell('Target Price', '2d2d44'),
        dataCell(`$${metrics.target_price.toFixed(2)}`, true, true),
        headerCell('Margin', '2d2d44'),
        dataCell(`${metrics.margin_percent.toFixed(1)}% ($${metrics.margin_dollars.toFixed(2)})`, true, true),
      ],
    }),
  ];

  const metricsTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: metricsRows,
  });

  // ── Dry Run Warning ───────────────────────────────────────────────────────
  const dryRunPara = dryRun
    ? new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120 },
        children: [new TextRun({ text: '⚠  DRY RUN — Inventory was NOT updated', bold: true, color: 'cc0000', size: 20 })],
      })
    : null;

  // ── Assemble Document ────────────────────────────────────────────────────
  const children = [
    headerTable,
    new Paragraph({ spacing: { before: 200 } }),
    infoTable,
    new Paragraph({ spacing: { before: 200 } }),
    divider(),
    packTable,
    new Paragraph({ spacing: { before: 200 } }),
    divider(),
    metricsTable,
  ];

  if (dryRunPara) children.push(dryRunPara);

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(0.5),
            right: convertInchesToTwip(0.5),
            bottom: convertInchesToTwip(0.5),
            left: convertInchesToTwip(0.5),
          },
        },
      },
      children,
    }],
  });

  return await Packer.toBuffer(doc);
}

/** Generate a safe filename for the DOCX */
export function bundleFilename(bundleType, customerName) {
  const safeType = bundleType.toLowerCase().replace(/\s+/g, '-');
  const safeName = (customerName || 'bundle').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ts = new Date().toISOString().slice(0, 10);
  return `${safeType}-${safeName}-${ts}.docx`;
}

/**
 * Fill a .docx template using docxtemplater.
 * The template should use {placeholder} syntax and {#packs}...{/packs} for the pack list loop.
 */
export async function generateBundleDocxFromTemplate(templateBuffer, bundleData, customerName = 'Walk-in', bundleType = 'Chaos Club', dryRun = false) {
  const PizZip = (await import('pizzip')).default;
  const Docxtemplater = (await import('docxtemplater')).default;

  const packs = bundleData.packs || [];
  const orderedPacks = [...packs.filter(p => p.is_collector), ...packs.filter(p => !p.is_collector)];
  const m = bundleData.metrics || {};

  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

  doc.render({
    customer_name: customerName,
    date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    bundle_type: bundleType,
    pack_count: String(packs.length),
    total_retail: `$${(m.total_retail || 0).toFixed(2)}`,
    target_price: `$${(m.target_price || 0).toFixed(2)}`,
    margin_percent: `${(m.margin_percent || 0).toFixed(1)}%`,
    margin_dollars: `$${(m.margin_dollars || 0).toFixed(2)}`,
    d20_roll: bundleData.d20Result?.roll ? String(bundleData.d20Result.roll) : '',
    d20_result: bundleData.d20Result?.upgraded ? '★ UPGRADE!' : (bundleData.d20Result?.roll ? 'No upgrade' : ''),
    dry_run_label: dryRun ? 'DRY RUN' : 'LIVE',
    packs: orderedPacks.map((p, i) => ({
      pack_num: String(i + 1),
      pack_name: p.product_title + (p.variant_title ? ` – ${p.variant_title}` : ''),
      pack_type: p.is_collector ? 'COLLECTOR' : '',
      pack_price: `$${p.price.toFixed(2)}`,
    })),
  });

  return doc.getZip().generate({ type: 'nodebuffer' });
}
