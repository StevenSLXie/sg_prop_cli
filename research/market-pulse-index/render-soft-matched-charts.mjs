#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const OUT_DIR = "research/market-pulse-index/output";
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

// Curated, harmonious categorical palette so every chart shares one consistent look.
const PALETTE = ["#2f6df0", "#ef6f53", "#13a378", "#9b59e0", "#e0467d", "#0ea5b5", "#e0a317", "#7c8a3a"];

// Xiaohongshu (RED) native portrait ratio is 3:4. 1080x1440 fills the feed cleanly.
const CANVAS = { width: 1080, height: 1440 };
const MARGIN = 64;
const INK = "#1f2430";
const MUTED = "#6b7280";
const FAINT = "#9aa1ad";
const GRID = "#ece9e2";
const PANEL = "#ffffff";
const BG_TOP = "#fbfaf7";
const BG_BOTTOM = "#f0eee7";

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
    const svgPath = join(OUT_DIR, chart.filename);
    const pngPath = join(OUT_DIR, pngFilename(chart.filename));
    await writeFile(svgPath, svg, "utf8");
    await writeFile(pngPath, svgToPng(svg));
    if (LEGACY_ALIASES[chart.filename]) {
      const alias = LEGACY_ALIASES[chart.filename];
      await writeFile(join(OUT_DIR, alias), svg, "utf8");
      await writeFile(join(OUT_DIR, pngFilename(alias)), svgToPng(svg));
    }
    outputs.push(pngPath);
    summaries.push({
      chart: pngFilename(chart.filename),
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

function svgToPng(svg) {
  return new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: CANVAS.width
    }
  }).render().asPng();
}

function pngFilename(filename) {
  return filename.replace(/\.svg$/i, ".png");
}

function prepareChart(chart, points) {
  const series = chart.series.map((definition, i) => {
    const rows = points
      .filter((point) => point.index_key === definition.key)
      .filter((point) => point.period_end_month >= START_MONTH && point.period_end_month <= END_MONTH)
      .filter((point) => point.price_index !== null && point.confidence !== "None")
      .sort((a, b) => a.period_end_month.localeCompare(b.period_end_month));
    const base = rows[0]?.price_index ?? null;
    return {
      ...definition,
      color: PALETTE[i % PALETTE.length],
      points: rows
        .map((point) => ({
          month: point.period_end_month,
          rebased: base ? (100 * point.price_index) / base : null,
          confidence: point.confidence
        }))
        .filter((point) => Number.isFinite(point.rebased))
    };
  });
  const months = [...new Set(series.flatMap((item) => item.points.map((point) => point.month)))].sort();
  return { months, series };
}

function renderSvg(chart, prepared) {
  const W = CANVAS.width;
  const H = CANVAS.height;
  const n = prepared.series.length;

  // --- Header layout (kicker + wrapped title + wrapped subtitle), measured top-down. ---
  const isNewSale = /NEW_SALE/.test(chart.series[0]?.key ?? "");
  const kicker = isNewSale ? "SINGAPORE CONDO · NEW-SALE PULSE" : "SINGAPORE CONDO · RESALE PULSE";
  const displayTitle = chart.title.replace(/^Soft Matched\s+/, "");
  const kickerY = MARGIN + 30;
  const titleLines = wrapText(displayTitle, 30);
  const titleTop = kickerY + 52;
  const titleLineH = 50;
  const subTop = titleTop + (titleLines.length - 1) * titleLineH + 44;
  const subLines = wrapText(chart.subtitle, 64);
  const subLineH = 28;
  const headerBottom = subTop + (subLines.length - 1) * subLineH + 10;

  // --- Bottom-up: footer, then legend, then plot fills the middle. ---
  const footerY = H - 46;
  const legendRows = Math.ceil(n / 2);
  const legendRowH = 48;
  const legendBottomBaseline = footerY - 50;
  const legendTopBaseline = legendBottomBaseline - (legendRows - 1) * legendRowH;

  const plotLeft = MARGIN + 34;
  const plotRight = W - MARGIN;
  const plotTop = headerBottom + 38;
  const plotBottom = legendTopBaseline - 64;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  // --- Scales (always include the 100 baseline; round to a nice step). ---
  const values = prepared.series.flatMap((s) => s.points.map((p) => p.rebased)).filter(Number.isFinite);
  const rawMin = Math.min(100, ...values);
  const rawMax = Math.max(100, ...values);
  const step = niceStep(Math.max(1, rawMax - rawMin), 6);
  const minY = Math.floor(rawMin / step) * step;
  const maxY = Math.ceil(rawMax / step) * step;
  const monthIndex = new Map(prepared.months.map((m, i) => [m, i]));
  const span = Math.max(1, prepared.months.length - 1);
  const x = (m) => plotLeft + (plotW * monthIndex.get(m)) / span;
  const y = (v) => plotTop + plotH - ((v - minY) / (maxY - minY)) * plotH;

  // --- Plot panel + gridlines. ---
  const panelPad = 22;
  const panel = `<rect x="${plotLeft - panelPad}" y="${plotTop - panelPad}" width="${plotW + panelPad * 2}" height="${plotH + panelPad * 2}" rx="22" fill="${PANEL}"/>`;
  const grid = [];
  for (let v = minY; v <= maxY + 1e-9; v += step) {
    const gy = y(v);
    const isBase = Math.abs(v - 100) < 1e-9;
    grid.push(`<line x1="${plotLeft}" y1="${gy}" x2="${plotRight}" y2="${gy}" stroke="${isBase ? "#cbb89a" : GRID}" stroke-width="${isBase ? 1.4 : 1}" ${isBase ? 'stroke-dasharray="5 5"' : ""}/>`);
    grid.push(`<text x="${plotLeft - 14}" y="${gy + 4}" text-anchor="end" font-size="17" fill="${isBase ? "#a9854d" : FAINT}" font-weight="${isBase ? 600 : 400}">${round(v, 0)}</text>`);
  }

  // --- Year ticks along the bottom. ---
  const xLabels = prepared.months
    .filter((m, i) => m.endsWith("-01") || i === prepared.months.length - 1)
    .map((m) => `<text x="${x(m)}" y="${plotBottom + 34}" text-anchor="middle" font-size="17" fill="${MUTED}">${m.endsWith("-01") ? m.slice(0, 4) : monthShort(m)}</text>`)
    .join("\n");

  // --- Lines: solid for month-contiguous runs, dashed for bridged spans, dot at the latest point. ---
  const strokeW = n > 5 ? 3 : 3.8;
  const lines = prepared.series.map((s) => {
    const { runs, bridges } = splitRuns(s.points);
    const solids = runs
      .filter((run) => run.length > 1)
      .map((run) => `<polyline points="${run.map((p) => `${round(x(p.month), 1)},${round(y(p.rebased), 1)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="${strokeW}" stroke-opacity="${n > 5 ? 0.92 : 1}" stroke-linejoin="round" stroke-linecap="round"/>`)
      .join("");
    const dashed = bridges
      .map(([a, b]) => `<line x1="${round(x(a.month), 1)}" y1="${round(y(a.rebased), 1)}" x2="${round(x(b.month), 1)}" y2="${round(y(b.rebased), 1)}" stroke="${s.color}" stroke-width="2.4" stroke-dasharray="4 6" stroke-linecap="round" opacity="0.55"/>`)
      .join("");
    const last = s.points.at(-1);
    const dot = last
      ? `<circle cx="${round(x(last.month), 1)}" cy="${round(y(last.rebased), 1)}" r="5.5" fill="${s.color}" stroke="#ffffff" stroke-width="2.5"/>`
      : "";
    return solids + dashed + dot;
  }).join("\n");

  // --- Legend pills (two columns). ---
  const colW = plotW / 2;
  const legend = prepared.series.map((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cx = plotLeft + col * colW;
    const cy = legendTopBaseline + row * legendRowH;
    const latest = s.points.at(-1);
    const value = latest ? round(latest.rebased, 1).toFixed(1) : "—";
    const label = truncate(s.label, 30);
    return `<g>
    <circle cx="${cx + 7}" cy="${cy - 5}" r="7" fill="${s.color}"/>
    <text x="${cx + 24}" y="${cy}" font-size="20" fill="${INK}">${escapeXml(label)}</text>
    <text x="${cx + colW - 30}" y="${cy}" text-anchor="end" font-size="20" font-weight="700" fill="${s.color}">${value}</text>
  </g>`;
  }).join("\n");

  const titleSvg = titleLines
    .map((line, i) => `<text x="${MARGIN}" y="${titleTop + i * titleLineH}" font-size="42" font-weight="800" fill="${INK}" font-family="Georgia, 'Times New Roman', serif">${escapeXml(line)}</text>`)
    .join("\n");
  const subSvg = subLines
    .map((line, i) => `<text x="${MARGIN}" y="${subTop + i * subLineH}" font-size="20" fill="${MUTED}">${escapeXml(line)}</text>`)
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BG_TOP}"/>
      <stop offset="1" stop-color="${BG_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <text x="${MARGIN}" y="${kickerY}" font-size="19" font-weight="700" letter-spacing="3" fill="${PALETTE[0]}">${escapeXml(kicker)}</text>
  ${titleSvg}
  ${subSvg}
  <rect x="${plotLeft - panelPad + 5}" y="${plotTop - panelPad + 8}" width="${plotW + panelPad * 2}" height="${plotH + panelPad * 2}" rx="22" fill="#1f2430" opacity="0.05"/>
  ${panel}
  ${grid.join("\n")}
  ${lines}
  ${xLabels}
  ${legend}
  <text x="${MARGIN}" y="${footerY}" font-size="16" fill="${FAINT}">Source: URA caveats · Method: soft matched-basket v0.6 · rebased to first 2022 point = 100 · dashed = bridged gap</text>
</svg>
`;
}

function splitRuns(points) {
  const runs = [];
  const bridges = [];
  let run = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && monthNum(points[i].month) - monthNum(points[i - 1].month) > 1) {
      bridges.push([points[i - 1], points[i]]);
      if (run.length) runs.push(run);
      run = [];
    }
    run.push(points[i]);
  }
  if (run.length) runs.push(run);
  return { runs, bridges };
}

function monthNum(month) {
  const [y, m] = month.split("-").map(Number);
  return y * 12 + (m - 1);
}

function monthShort(month) {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(month.slice(5, 7)) - 1]} ${month.slice(2, 4)}`;
}

function niceStep(range, target) {
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const candidate = [1, 2, 2.5, 5, 10].map((c) => c * pow).find((c) => c >= raw);
  return candidate ?? 10 * pow;
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= maxChars) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function truncate(text, maxChars) {
  const value = String(text);
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

function escapeXml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
