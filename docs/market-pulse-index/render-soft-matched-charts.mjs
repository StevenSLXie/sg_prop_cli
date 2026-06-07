#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "docs/market-pulse-index/output";
const INDEX_PATH = join(OUT_DIR, "soft-matched-index-points.json");
const START_MONTH = "2022-01";
const END_MONTH = "2026-05";

const CHARTS = [
  {
    filename: "soft-matched-resale-by-size.svg",
    title: "Soft Matched Resale Market Pulse by Size",
    subtitle: "Resale condo/apartment, monthly 3M rolling points, rebased to first available 2022 point = 100.",
    series: [
      { key: "SG_CONDO_RESALE_SIZE_COMPACT", label: "<=800 sqft", color: "#2563eb" },
      { key: "SG_CONDO_RESALE_SIZE_FAMILY", label: "800-1200 sqft", color: "#0f766e" },
      { key: "SG_CONDO_RESALE_SIZE_LARGE", label: ">1200 sqft", color: "#c2410c" }
    ]
  },
  {
    filename: "soft-matched-resale-by-lease-age.svg",
    title: "Soft Matched Resale Market Pulse by Lease Age",
    subtitle: "Leasehold resale condo/apartment, grouped by years since lease commencement; TOP year is not available in the transaction feed.",
    series: [
      { key: "SG_CONDO_RESALE_LEASE_AGE_0_10", label: "<=10 years", color: "#2563eb" },
      { key: "SG_CONDO_RESALE_LEASE_AGE_11_20", label: "11-20 years", color: "#0f766e" },
      { key: "SG_CONDO_RESALE_LEASE_AGE_21_30", label: "21-30 years", color: "#c2410c" },
      { key: "SG_CONDO_RESALE_LEASE_AGE_30_PLUS", label: ">30 years", color: "#7c3aed" }
    ]
  },
  {
    filename: "soft-matched-resale-by-region.svg",
    title: "Soft Matched Resale Market Pulse by Region",
    subtitle: "CCR, RCR and OCR resale condo/apartment trends, rebased to first available 2022 point = 100.",
    series: [
      { key: "SG_CONDO_RESALE_CCR", label: "CCR", color: "#7c3aed" },
      { key: "SG_CONDO_RESALE_RCR", label: "RCR", color: "#0f766e" },
      { key: "SG_CONDO_RESALE_OCR", label: "OCR", color: "#c2410c" }
    ]
  },
  {
    filename: "soft-matched-resale-key-districts.svg",
    title: "Soft Matched Resale Market Pulse by Key District",
    subtitle: "Selected liquid resale districts, rebased to first available 2022 point = 100.",
    series: [
      { key: "SG_CONDO_RESALE_D05", label: "D05 Buona Vista / West Coast", color: "#2563eb" },
      { key: "SG_CONDO_RESALE_D09", label: "D09 Orchard / River Valley", color: "#9333ea" },
      { key: "SG_CONDO_RESALE_D10", label: "D10 Tanglin / Holland / Bukit Timah", color: "#4f46e5" },
      { key: "SG_CONDO_RESALE_D15", label: "D15 Katong / Joo Chiat / Amber", color: "#0f766e" },
      { key: "SG_CONDO_RESALE_D18", label: "D18 Tampines / Pasir Ris", color: "#ea580c" },
      { key: "SG_CONDO_RESALE_D19", label: "D19 Serangoon / Hougang / Punggol", color: "#dc2626" },
      { key: "SG_CONDO_RESALE_D21", label: "D21 Clementi / Upper Bukit Timah", color: "#0891b2" },
      { key: "SG_CONDO_RESALE_D23", label: "D23 Bukit Batok / Choa Chu Kang", color: "#65a30d" }
    ]
  },
  {
    filename: "soft-matched-new-sale-by-size.svg",
    title: "Soft Matched New Sale Market Pulse by Size",
    subtitle: "New sale condo/apartment, monthly 3M rolling points, rebased to first available 2022 point = 100.",
    series: [
      { key: "SG_CONDO_NEW_SALE_SIZE_COMPACT", label: "<=800 sqft", color: "#2563eb" },
      { key: "SG_CONDO_NEW_SALE_SIZE_FAMILY", label: "800-1200 sqft", color: "#0f766e" },
      { key: "SG_CONDO_NEW_SALE_SIZE_LARGE", label: ">1200 sqft", color: "#c2410c" }
    ]
  },
  {
    filename: "soft-matched-new-sale-by-region.svg",
    title: "Soft Matched New Sale Market Pulse by Region",
    subtitle: "CCR, RCR and OCR new sale condo/apartment trends, rebased to first available 2022 point = 100.",
    series: [
      { key: "SG_CONDO_NEW_SALE_CCR", label: "CCR", color: "#7c3aed" },
      { key: "SG_CONDO_NEW_SALE_RCR", label: "RCR", color: "#0f766e" },
      { key: "SG_CONDO_NEW_SALE_OCR", label: "OCR", color: "#c2410c" }
    ]
  },
  {
    filename: "soft-matched-new-sale-key-districts.svg",
    title: "Soft Matched New Sale Market Pulse by Key District",
    subtitle: "Selected new sale districts with enough usable points, rebased to first available 2022 point = 100.",
    series: [
      { key: "SG_CONDO_NEW_SALE_D05", label: "D05 Buona Vista / West Coast", color: "#2563eb" },
      { key: "SG_CONDO_NEW_SALE_D09", label: "D09 Orchard / River Valley", color: "#9333ea" },
      { key: "SG_CONDO_NEW_SALE_D10", label: "D10 Tanglin / Holland / Bukit Timah", color: "#4f46e5" },
      { key: "SG_CONDO_NEW_SALE_D15", label: "D15 Katong / Joo Chiat / Amber", color: "#0f766e" },
      { key: "SG_CONDO_NEW_SALE_D18", label: "D18 Tampines / Pasir Ris", color: "#ea580c" },
      { key: "SG_CONDO_NEW_SALE_D19", label: "D19 Serangoon / Hougang / Punggol", color: "#dc2626" },
      { key: "SG_CONDO_NEW_SALE_D21", label: "D21 Clementi / Upper Bukit Timah", color: "#0891b2" },
      { key: "SG_CONDO_NEW_SALE_D23", label: "D23 Bukit Batok / Choa Chu Kang", color: "#65a30d" }
    ]
  }
];

const LEGACY_ALIASES = {
  "soft-matched-resale-by-size.svg": "soft-matched-by-size.svg",
  "soft-matched-resale-by-region.svg": "soft-matched-by-region.svg",
  "soft-matched-resale-key-districts.svg": "soft-matched-key-districts.svg"
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const index = JSON.parse(await readFile(INDEX_PATH, "utf8"));
  const outputs = [];
  const summaries = [];
  for (const chart of CHARTS) {
    const prepared = prepareChart(chart, index.points);
    const svg = renderSvg(chart, prepared);
    await writeFile(join(OUT_DIR, chart.filename), svg, "utf8");
    if (LEGACY_ALIASES[chart.filename]) {
      await writeFile(join(OUT_DIR, LEGACY_ALIASES[chart.filename]), svg, "utf8");
    }
    outputs.push(join(OUT_DIR, chart.filename));
    summaries.push({
      chart: chart.filename,
      series: prepared.series.map((series) => ({
        label: series.label,
        start_month: series.points[0]?.month ?? null,
        end_month: series.points.at(-1)?.month ?? null,
        latest_rebased: round(series.points.at(-1)?.rebased ?? null, 2),
        latest_confidence: series.points.at(-1)?.confidence ?? null
      }))
    });
  }
  console.log(JSON.stringify({ ok: true, outputs, summaries }, null, 2));
}

function prepareChart(chart, points) {
  const series = chart.series.map((definition) => {
    const rows = points
      .filter((point) => point.index_key === definition.key)
      .filter((point) => point.period_end_month >= START_MONTH && point.period_end_month <= END_MONTH)
      .filter((point) => point.price_index !== null && point.confidence !== "None")
      .sort((a, b) => a.period_end_month.localeCompare(b.period_end_month));
    const base = rows[0]?.price_index ?? null;
    return {
      ...definition,
      points: rows
        .map((point) => {
          return {
            month: point.period_end_month,
            rebased: base ? (100 * point.price_index) / base : null,
            confidence: point.confidence,
            segment: point.price_index_segment ?? 0,
            sample_size: point.sample_size,
            matched_coverage: point.matched_coverage,
            fallback_share: point.fallback_share,
            floor_similarity_avg: point.floor_similarity_avg
          };
        })
        .filter((point) => Number.isFinite(point.rebased))
    };
  });
  const months = [...new Set(series.flatMap((item) => item.points.map((point) => point.month)))].sort();
  return { months, series };
}

function renderSvg(chart, prepared) {
  const width = 1280;
  const height = chart.series.length > 5 ? 820 : 720;
  const pad = { left: 70, right: 40, top: 76, bottom: chart.series.length > 5 ? 210 : 150 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const values = prepared.series.flatMap((series) => series.points.map((point) => point.rebased)).filter(Number.isFinite);
  const minY = Math.floor(Math.min(...values) / 2) * 2;
  const maxY = Math.ceil(Math.max(...values) / 2) * 2;
  const monthIndex = new Map(prepared.months.map((month, index) => [month, index]));
  const x = (month) => pad.left + (plotWidth * monthIndex.get(month)) / Math.max(1, prepared.months.length - 1);
  const y = (value) => pad.top + plotHeight - ((value - minY) / (maxY - minY)) * plotHeight;
  const grid = [];
  for (let value = minY; value <= maxY; value += 2) {
    grid.push(`<line x1="${pad.left}" y1="${y(value)}" x2="${width - pad.right}" y2="${y(value)}" stroke="#e5e7eb"/>`);
    grid.push(`<text x="${pad.left - 10}" y="${y(value) + 4}" text-anchor="end" font-size="12" fill="#4b5563">${value}</text>`);
  }
  const lines = prepared.series.flatMap((series) => {
    const segments = groupBy(series.points, (point) => point.segment);
    return [...segments.values()].map((points) => {
      const coordinates = points.map((point) => `${x(point.month)},${y(point.rebased)}`).join(" ");
      return `<polyline points="${coordinates}" fill="none" stroke="${series.color}" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/>`;
    });
  }).join("\n");
  const labels = prepared.months
    .filter((month) => /-(01|04|07|10)$/.test(month))
    .map((month) => `<text x="${x(month)}" y="${height - pad.bottom + 28}" text-anchor="middle" font-size="11" fill="#4b5563">${month}</text>`)
    .join("\n");
  const legend = prepared.series.map((series, index) => {
    const row = Math.floor(index / 2);
    const col = index % 2;
    const x0 = pad.left + col * 520;
    const y0 = height - pad.bottom + 62 + row * 24;
    const latest = series.points.at(-1);
    const suffix = latest ? ` ${round(latest.rebased, 1)}` : "";
    return `<g><line x1="${x0}" y1="${y0}" x2="${x0 + 34}" y2="${y0}" stroke="${series.color}" stroke-width="3"/><text x="${x0 + 42}" y="${y0 + 4}" font-size="13" fill="#111827">${escapeXml(series.label)}${suffix}</text></g>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${pad.left}" y="34" font-size="22" font-weight="700" fill="#111827">${escapeXml(chart.title)}</text>
  <text x="${pad.left}" y="56" font-size="13" fill="#4b5563">${escapeXml(chart.subtitle)}</text>
  ${grid.join("\n")}
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="#9ca3af"/>
  <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="#9ca3af"/>
  ${lines}
  ${labels}
  ${legend}
  <text x="${pad.left}" y="${height - 18}" font-size="12" fill="#6b7280">Method: soft matched-basket v0.5, project x size hard match, floor-distance kernel, condominium/apartment only.</text>
</svg>
`;
}

function escapeXml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const group = map.get(key);
    if (group) group.push(row);
    else map.set(key, [row]);
  }
  return map;
}
