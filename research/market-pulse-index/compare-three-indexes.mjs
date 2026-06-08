#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "research/market-pulse-index/output";
const URA_COMPARISON_PATH = join(OUT_DIR, "ura-comparison.json");
const SRX_MONTHLY_PATH = "research/market-pulse-index/srx-monthly-public.csv";

const SERIES = [
  { key: "overall", color: "#111827" },
  { key: "CCR", color: "#7c3aed" },
  { key: "RCR", color: "#0f766e" },
  { key: "OCR", color: "#c2410c" }
];

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const uraComparison = JSON.parse(await readFile(URA_COMPARISON_PATH, "utf8"));
  const srxMonthly = parseCsv(await readFile(SRX_MONTHLY_PATH, "utf8"));
  const srxIndexes = buildSrxIndexes(srxMonthly);
  const comparison = buildThreeWayComparison(uraComparison.rows, srxIndexes, srxMonthly);

  await writeFile(join(OUT_DIR, "three-index-comparison.csv"), toCsv(comparison.rows), "utf8");
  await writeFile(join(OUT_DIR, "three-index-comparison.json"), JSON.stringify(comparison, null, 2) + "\n", "utf8");
  await writeFile(join(OUT_DIR, "three-index-comparison.svg"), renderSvg(comparison), "utf8");

  console.log(JSON.stringify({
    ok: true,
    rows: comparison.rows.length,
    period_start: comparison.rows[0]?.quarter,
    period_end: comparison.rows.at(-1)?.quarter,
    outputs: [
      join(OUT_DIR, "three-index-comparison.csv"),
      join(OUT_DIR, "three-index-comparison.json"),
      join(OUT_DIR, "three-index-comparison.svg")
    ],
    correlations: comparison.correlations
  }, null, 2));
}

function buildSrxIndexes(rows) {
  const sorted = rows.toSorted((a, b) => a.month.localeCompare(b.month));
  const current = Object.fromEntries(SERIES.map((series) => [series.key, 100]));
  const indexes = [];
  for (const [index, row] of sorted.entries()) {
    if (index > 0) {
      for (const series of SERIES) {
        current[series.key] *= 1 + Number(row[`${series.key}_mom_pct`]) / 100;
      }
    }
    indexes.push({
      month: row.month,
      ...Object.fromEntries(SERIES.map((series) => [series.key, current[series.key]]))
    });
  }
  return indexes;
}

function buildThreeWayComparison(uraRows, srxIndexes, srxMonthly) {
  const srxQuarterMonths = new Set(srxIndexes.map((row) => row.month).filter((month) => /-(03|06|09|12)$/.test(month)));
  const quarters = uraRows
    .map((row) => row.quarter)
    .filter((quarter) => srxQuarterMonths.has(quarterToEndMonth(quarter)));
  const rows = quarters.map((quarter) => {
    const uraRow = uraRows.find((row) => row.quarter === quarter);
    const srxRow = srxIndexes.find((row) => row.month === quarterToEndMonth(quarter));
    const row = { quarter };
    for (const series of SERIES) {
      row[`${series.key}_our_raw`] = uraRow?.[`${series.key}_our_raw`] ?? null;
      row[`${series.key}_ura_raw`] = uraRow?.[`${series.key}_official_raw`] ?? null;
      row[`${series.key}_srx_raw`] = srxRow?.[series.key] ?? null;
    }
    return row;
  });

  const base = rows[0];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const previous = rows[i - 1];
    for (const series of SERIES) {
      for (const source of ["our", "ura", "srx"]) {
        const rawKey = `${series.key}_${source}_raw`;
        const rebasedKey = `${series.key}_${source}_rebased`;
        const qoqKey = `${series.key}_${source}_qoq_pct`;
        row[rebasedKey] = base?.[rawKey] ? (100 * row[rawKey]) / base[rawKey] : null;
        row[qoqKey] = previous ? pctChange(row[rawKey], previous[rawKey]) : null;
      }
    }
  }

  return {
    generated_at: new Date().toISOString(),
    base_quarter: rows[0]?.quarter,
    comparison_mode: "quarter_end_rebased_our_ura_srx",
    caveat: "SRX public source used here is monthly percentage movement from SRX research articles, chained into a relative index. It is not the raw SRX index-value table, which is not exposed through a stable public API in this repo.",
    srx_source_months: srxMonthly.map((row) => ({ month: row.month, source_url: row.source_url })),
    rows,
    correlations: buildCorrelations(rows)
  };
}

function buildCorrelations(rows) {
  if (rows.length < 5) {
    return {
      skipped: true,
      reason: "At least 5 quarter-end points are required before reporting return correlations."
    };
  }
  return Object.fromEntries(SERIES.map((series) => {
    const our = rows.slice(1).map((row) => row[`${series.key}_our_qoq_pct`]);
    const ura = rows.slice(1).map((row) => row[`${series.key}_ura_qoq_pct`]);
    const srx = rows.slice(1).map((row) => row[`${series.key}_srx_qoq_pct`]);
    return [series.key, {
      our_vs_ura: round(correlation(our, ura), 3),
      our_vs_srx: round(correlation(our, srx), 3),
      ura_vs_srx: round(correlation(ura, srx), 3)
    }];
  }));
}

function renderSvg(comparison) {
  const width = 1180;
  const height = 760;
  const pad = { left: 70, right: 30, top: 70, bottom: 85 };
  const rows = comparison.rows;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const values = rows.flatMap((row) => SERIES.flatMap((series) => [
    row[`${series.key}_our_rebased`],
    row[`${series.key}_ura_rebased`],
    row[`${series.key}_srx_rebased`]
  ])).filter(Number.isFinite);
  const minY = Math.floor(Math.min(...values) / 2) * 2;
  const maxY = Math.ceil(Math.max(...values) / 2) * 2;
  const x = (i) => pad.left + (plotWidth * i) / Math.max(1, rows.length - 1);
  const y = (v) => pad.top + plotHeight - ((v - minY) / (maxY - minY)) * plotHeight;
  const line = (series, source) => {
    const dash = source === "ura" ? ' stroke-dasharray="8 5"' : source === "srx" ? ' stroke-dasharray="2 6"' : "";
    const strokeWidth = source === "our" ? 3 : 2.3;
    const points = rows.map((row, i) => `${x(i)},${y(row[`${series.key}_${source}_rebased`])}`).join(" ");
    return `<polyline points="${points}" fill="none" stroke="${series.color}" stroke-width="${strokeWidth}" stroke-linecap="round"${dash}/>`;
  };
  const grid = [];
  for (let value = minY; value <= maxY; value += 2) {
    grid.push(`<line x1="${pad.left}" y1="${y(value)}" x2="${width - pad.right}" y2="${y(value)}" stroke="#e5e7eb"/>`);
    grid.push(`<text x="${pad.left - 10}" y="${y(value) + 4}" text-anchor="end" font-size="12" fill="#4b5563">${value}</text>`);
  }
  const xLabels = rows.map((row, i) => `<text x="${x(i)}" y="${height - 50}" text-anchor="middle" font-size="12" fill="#4b5563">${row.quarter.replace("Q", " Q")}</text>`).join("\n");
  const legend = SERIES.map((series, i) => {
    const y0 = 98 + i * 28;
    return `<g>
      <line x1="800" y1="${y0}" x2="835" y2="${y0}" stroke="${series.color}" stroke-width="3"/><text x="842" y="${y0 + 4}" font-size="13">${series.key} ours</text>
      <line x1="930" y1="${y0}" x2="965" y2="${y0}" stroke="${series.color}" stroke-width="2.3" stroke-dasharray="8 5"/><text x="972" y="${y0 + 4}" font-size="13">URA</text>
      <line x1="1030" y1="${y0}" x2="1065" y2="${y0}" stroke="${series.color}" stroke-width="2.3" stroke-dasharray="2 6"/><text x="1072" y="${y0 + 4}" font-size="13">SRX</text>
    </g>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${pad.left}" y="34" font-size="22" font-weight="700" fill="#111827">Singapore Condo Market Pulse vs URA vs SRX</text>
  <text x="${pad.left}" y="56" font-size="13" fill="#4b5563">Quarter-end points, rebased to ${comparison.base_quarter}=100. Solid = our resale condo/apartment index; dashed = URA; dotted = SRX monthly public movements chained.</text>
  ${grid.join("\n")}
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="#9ca3af"/>
  <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="#9ca3af"/>
  ${SERIES.map((series) => line(series, "our")).join("\n")}
  ${SERIES.map((series) => line(series, "ura")).join("\n")}
  ${SERIES.map((series) => line(series, "srx")).join("\n")}
  ${xLabels}
  ${legend}
  <text x="${pad.left}" y="${height - 18}" font-size="12" fill="#6b7280">Caveat: SRX line is reconstructed from public monthly percentage changes, not from SRX's raw index-value table.</text>
</svg>
`;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const columns = lines.shift().split(",");
  return lines.map((line) => {
    const values = line.split(",");
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  });
}

function toCsv(rows) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  return `${[columns.join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))].join("\n")}\n`;
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(typeof value === "number" ? round(value, 6) : value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function quarterToEndMonth(quarter) {
  const match = /^(\d{4})Q([1-4])$/.exec(quarter);
  const month = Number(match[2]) * 3;
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

function pctChange(current, previous) {
  if (!current || !previous) return null;
  return 100 * (current / previous - 1);
}

function correlation(a, b) {
  const pairs = a.map((value, index) => [value, b[index]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 2) return null;
  const meanA = pairs.reduce((sum, [x]) => sum + x, 0) / pairs.length;
  const meanB = pairs.reduce((sum, [, y]) => sum + y, 0) / pairs.length;
  const numerator = pairs.reduce((sum, [x, y]) => sum + (x - meanA) * (y - meanB), 0);
  const denominatorA = Math.sqrt(pairs.reduce((sum, [x]) => sum + (x - meanA) ** 2, 0));
  const denominatorB = Math.sqrt(pairs.reduce((sum, [, y]) => sum + (y - meanB) ** 2, 0));
  return denominatorA && denominatorB ? numerator / (denominatorA * denominatorB) : null;
}

function round(value, digits = 6) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
