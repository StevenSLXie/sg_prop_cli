#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "research/market-pulse-index/output";
const OUR_INDEX_PATH = join(OUT_DIR, "soft-matched-index-points.json");
const URA_TYPE_RESOURCE = "d_da00b36ca8c831322fa0bb2a3378a476";
const URA_LOCALITY_RESOURCE = "d_5754436c9a35951630ad5d09bbdba112";

const SERIES = [
  { key: "overall", our: "SG_CONDO_RESALE_OVERALL", official: "Non-Landed", officialSource: "type", color: "#1f2937" },
  { key: "CCR", our: "SG_CONDO_RESALE_CCR", official: "Core Central Region", officialSource: "locality", color: "#7c3aed" },
  { key: "RCR", our: "SG_CONDO_RESALE_RCR", official: "Rest Of Central Region", officialSource: "locality", color: "#0f766e" },
  { key: "OCR", our: "SG_CONDO_RESALE_OCR", official: "Outside Central Region", officialSource: "locality", color: "#c2410c" }
];

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const our = JSON.parse(await readFile(OUR_INDEX_PATH, "utf8"));
  const officialRows = {
    type: await fetchDataGovRows(URA_TYPE_RESOURCE),
    locality: await fetchDataGovRows(URA_LOCALITY_RESOURCE)
  };
  const comparison = buildComparison(our.points, officialRows);
  await writeFile(join(OUT_DIR, "soft-matched-ura-comparison.csv"), toCsv(comparison.rows), "utf8");
  await writeFile(join(OUT_DIR, "soft-matched-ura-comparison.json"), JSON.stringify(comparison, null, 2) + "\n", "utf8");
  await writeFile(join(OUT_DIR, "soft-matched-ura-comparison.svg"), renderSvg(comparison), "utf8");
  console.log(JSON.stringify({
    ok: true,
    rows: comparison.rows.length,
    period_start: comparison.rows[0]?.quarter,
    period_end: comparison.rows.at(-1)?.quarter,
    outputs: [
      join(OUT_DIR, "soft-matched-ura-comparison.csv"),
      join(OUT_DIR, "soft-matched-ura-comparison.json"),
      join(OUT_DIR, "soft-matched-ura-comparison.svg")
    ],
    correlations: comparison.correlations,
    direction_hit_rate: comparison.direction_hit_rate
  }, null, 2));
}

async function fetchDataGovRows(resourceId) {
  const url = new URL("https://data.gov.sg/api/action/datastore_search");
  url.searchParams.set("resource_id", resourceId);
  url.searchParams.set("limit", "10");
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`data.gov.sg returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload.success) throw new Error(`data.gov.sg returned unsuccessful response for ${resourceId}`);
  return payload.result.records;
}

function buildComparison(points, officialRows) {
  const quarters = quarterEndPoints(points, officialRows);
  const rows = quarters.map((quarter) => {
    const row = { quarter };
    for (const series of SERIES) {
      const ourPoint = points.find((point) => (
        point.index_key === series.our &&
        point.period_end_month === quarterToEndMonth(quarter) &&
        point.price_index !== null &&
        point.confidence !== "None"
      ));
      row[`${series.key}_our_raw`] = ourPoint?.price_index ?? null;
      row[`${series.key}_official_raw`] = officialValue(officialRows[series.officialSource], series.official, quarter);
      row[`${series.key}_our_confidence`] = ourPoint?.confidence ?? "";
      row[`${series.key}_matched_coverage`] = ourPoint?.matched_coverage ?? null;
      row[`${series.key}_fallback_share`] = ourPoint?.fallback_share ?? null;
      row[`${series.key}_top_project_weight`] = ourPoint?.top_project_weight ?? null;
    }
    return row;
  }).filter((row) => SERIES.every((series) => (
    Number.isFinite(row[`${series.key}_our_raw`]) &&
    Number.isFinite(row[`${series.key}_official_raw`])
  )));

  const baseQuarter = rows[0]?.quarter;
  for (const series of SERIES) {
    const ourBase = rows[0]?.[`${series.key}_our_raw`];
    const officialBase = rows[0]?.[`${series.key}_official_raw`];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      row[`${series.key}_our_rebased`] = ourBase ? (100 * row[`${series.key}_our_raw`]) / ourBase : null;
      row[`${series.key}_official_rebased`] = officialBase ? (100 * row[`${series.key}_official_raw`]) / officialBase : null;
      if (i > 0) {
        const prev = rows[i - 1];
        row[`${series.key}_our_qoq_pct`] = pctChange(row[`${series.key}_our_raw`], prev[`${series.key}_our_raw`]);
        row[`${series.key}_official_qoq_pct`] = pctChange(row[`${series.key}_official_raw`], prev[`${series.key}_official_raw`]);
      } else {
        row[`${series.key}_our_qoq_pct`] = null;
        row[`${series.key}_official_qoq_pct`] = null;
      }
    }
  }

  const correlations = Object.fromEntries(SERIES.map((series) => {
    const ourReturns = rows.slice(1).map((row) => row[`${series.key}_our_qoq_pct`]);
    const officialReturns = rows.slice(1).map((row) => row[`${series.key}_official_qoq_pct`]);
    return [series.key, round(correlation(ourReturns, officialReturns), 3)];
  }));
  const directionHitRate = Object.fromEntries(SERIES.map((series) => {
    const pairs = rows.slice(1)
      .map((row) => [row[`${series.key}_our_qoq_pct`], row[`${series.key}_official_qoq_pct`]])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    const hits = pairs.filter(([a, b]) => Math.sign(a) === Math.sign(b)).length;
    return [series.key, pairs.length ? round(hits / pairs.length, 3) : null];
  }));

  return {
    generated_at: new Date().toISOString(),
    base_quarter: baseQuarter,
    comparison_mode: "soft_matched_quarter_end_3m_rolling_vs_official_quarterly",
    caveat: "Soft matched-basket index uses resale Condominium/Apartment transactions only. URA official indexes cover non-landed private residential properties by locality and use URA's official stratified hedonic methodology; scope is not identical.",
    rows,
    correlations,
    direction_hit_rate: directionHitRate
  };
}

function quarterEndPoints(points, officialRows) {
  const officialQuarters = new Set();
  for (const sourceRows of Object.values(officialRows)) {
    for (const row of sourceRows) {
      for (const key of Object.keys(row)) {
        if (/^\d{4}[1-4]Q$/.test(key) && row[key] !== null && row[key] !== "") {
          officialQuarters.add(`${key.slice(0, 4)}Q${key[4]}`);
        }
      }
    }
  }
  const months = new Set(points
    .filter((point) => point.index_key === "SG_CONDO_RESALE_OVERALL" && point.price_index !== null && point.confidence !== "None")
    .map((point) => point.period_end_month));
  return [...months]
    .filter((month) => /-(03|06|09|12)$/.test(month))
    .map(monthToQuarter)
    .filter((quarter) => officialQuarters.has(quarter))
    .sort();
}

function officialValue(rows, dataSeries, quarter) {
  const row = rows.find((record) => String(record.DataSeries ?? "").trim() === dataSeries);
  if (!row) return null;
  return Number(row[quarterToOfficialColumn(quarter)] ?? null);
}

function quarterToOfficialColumn(quarter) {
  const match = /^(\d{4})Q([1-4])$/.exec(quarter);
  if (!match) throw new Error(`Invalid quarter ${quarter}`);
  return `${match[1]}${match[2]}Q`;
}

function quarterToEndMonth(quarter) {
  const match = /^(\d{4})Q([1-4])$/.exec(quarter);
  const month = Number(match[2]) * 3;
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

function monthToQuarter(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${year}Q${Math.floor((monthNumber - 1) / 3) + 1}`;
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

function renderSvg(comparison) {
  const width = 1180;
  const height = 760;
  const pad = { left: 70, right: 30, top: 70, bottom: 80 };
  const rows = comparison.rows;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const values = rows.flatMap((row) => SERIES.flatMap((series) => [
    row[`${series.key}_our_rebased`],
    row[`${series.key}_official_rebased`]
  ])).filter(Number.isFinite);
  const minY = Math.floor(Math.min(...values) / 2) * 2;
  const maxY = Math.ceil(Math.max(...values) / 2) * 2;
  const x = (i) => pad.left + (plotWidth * i) / Math.max(1, rows.length - 1);
  const y = (v) => pad.top + plotHeight - ((v - minY) / (maxY - minY)) * plotHeight;
  const line = (series, official) => {
    const attr = official ? "official_rebased" : "our_rebased";
    const points = rows.map((row, i) => `${x(i)},${y(row[`${series.key}_${attr}`])}`).join(" ");
    const dash = official ? ' stroke-dasharray="7 5"' : "";
    return `<polyline points="${points}" fill="none" stroke="${series.color}" stroke-width="${official ? 2 : 3}"${dash}/>`;
  };
  const grid = [];
  for (let value = minY; value <= maxY; value += 2) {
    grid.push(`<line x1="${pad.left}" y1="${y(value)}" x2="${width - pad.right}" y2="${y(value)}" stroke="#e5e7eb"/>`);
    grid.push(`<text x="${pad.left - 10}" y="${y(value) + 4}" text-anchor="end" font-size="12" fill="#4b5563">${value}</text>`);
  }
  const xLabels = rows.map((row, i) => `<text x="${x(i)}" y="${height - 45}" text-anchor="middle" font-size="11" fill="#4b5563">${row.quarter.replace("Q", " Q")}</text>`).join("\n");
  const legend = SERIES.map((series, i) => {
    const y0 = 96 + i * 24;
    return `<g><line x1="865" y1="${y0}" x2="900" y2="${y0}" stroke="${series.color}" stroke-width="3"/><text x="908" y="${y0 + 4}" font-size="13">${series.key} soft</text><line x1="1000" y1="${y0}" x2="1035" y2="${y0}" stroke="${series.color}" stroke-width="2" stroke-dasharray="7 5"/><text x="1043" y="${y0 + 4}" font-size="13">URA</text></g>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${pad.left}" y="34" font-size="22" font-weight="700" fill="#111827">Soft Matched Condo Market Pulse vs URA</text>
  <text x="${pad.left}" y="56" font-size="13" fill="#4b5563">Quarter-end 3M rolling points, rebased to ${comparison.base_quarter}=100. Solid = soft matched-basket; dashed = official URA/SingStat index.</text>
  ${grid.join("\n")}
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="#9ca3af"/>
  <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="#9ca3af"/>
  ${SERIES.map((series) => line(series, false)).join("\n")}
  ${SERIES.map((series) => line(series, true)).join("\n")}
  ${xLabels}
  ${legend}
  <text x="${pad.left}" y="${height - 18}" font-size="12" fill="#6b7280">Caveat: scopes differ. Soft index excludes new sale, sub-sale, EC and landed.</text>
</svg>
`;
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

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
