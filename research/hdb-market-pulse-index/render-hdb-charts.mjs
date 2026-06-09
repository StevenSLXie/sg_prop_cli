#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { parseArgs } from "../lib/market-pulse-core.mjs";

const DEFAULT_OUT_DIR = "research/hdb-market-pulse-index/output";
const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}
const OUT_DIR = args.out ?? DEFAULT_OUT_DIR;
const INDEX_PATH = args.index ?? join(OUT_DIR, "hdb-index-points.json");

const CHARTS = [
  {
    filename: "hdb-resale-by-flat-type.svg",
    title: "HDB Resale Market Pulse by Flat Type",
    subtitle: "Monthly 3M rolling points, soft matched with area, lease, street/block and floor signals; rebased to first available 2022 point = 100.",
    series: [
      { key: "SG_HDB_RESALE_3_ROOM", label: "3-room", color: "#2f6df0" },
      { key: "SG_HDB_RESALE_4_ROOM", label: "4-room", color: "#13a378" },
      { key: "SG_HDB_RESALE_5_ROOM", label: "5-room", color: "#ef6f53" },
      { key: "SG_HDB_RESALE_EXECUTIVE", label: "Executive", color: "#9b59e0" }
    ]
  },
  {
    filename: "hdb-resale-by-remaining-lease.svg",
    title: "HDB Resale Market Pulse by Remaining Lease",
    subtitle: "10-year remaining-lease bands; 90-99 years captures newer post-MOP stock. Rebased to first available 2022 point = 100.",
    series: [
      { key: "SG_HDB_RESALE_LEASE_40_49", label: "40-49 years", color: "#7c8a3a" },
      { key: "SG_HDB_RESALE_LEASE_50_59", label: "50-59 years", color: "#2f6df0" },
      { key: "SG_HDB_RESALE_LEASE_60_69", label: "60-69 years", color: "#13a378" },
      { key: "SG_HDB_RESALE_LEASE_70_79", label: "70-79 years", color: "#ef6f53" },
      { key: "SG_HDB_RESALE_LEASE_80_89", label: "80-89 years", color: "#9b59e0" },
      { key: "SG_HDB_RESALE_LEASE_90_99", label: "90-99 years", color: "#e0467d" }
    ]
  },
  {
    filename: "hdb-resale-key-towns.svg",
    title: "HDB Resale Market Pulse by Key Town",
    subtitle: "Selected liquid towns, town indexes normalized by flat-type mix and soft matched inside town x flat-type cells.",
    series: [
      { key: "SG_HDB_RESALE_TOWN_ANG_MO_KIO", label: "Ang Mo Kio", color: "#2f6df0" },
      { key: "SG_HDB_RESALE_TOWN_BUKIT_MERAH", label: "Bukit Merah", color: "#ef6f53" },
      { key: "SG_HDB_RESALE_TOWN_CLEMENTI", label: "Clementi", color: "#13a378" },
      { key: "SG_HDB_RESALE_TOWN_QUEENSTOWN", label: "Queenstown", color: "#9b59e0" },
      { key: "SG_HDB_RESALE_TOWN_SENGKANG", label: "Sengkang", color: "#e0467d" },
      { key: "SG_HDB_RESALE_TOWN_TAMPINES", label: "Tampines", color: "#0ea5b5" },
      { key: "SG_HDB_RESALE_TOWN_TOA_PAYOH", label: "Toa Payoh", color: "#e0a317" },
      { key: "SG_HDB_RESALE_TOWN_WOODLANDS", label: "Woodlands", color: "#7c8a3a" }
    ]
  }
];

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
  const startMonth = args["start-month"] ?? index.scope?.start_month ?? "2022-01";
  const endMonth = args["end-month"] ?? index.scope?.end_month ?? latestMonth(index.points);
  const outputs = [];
  const summaries = [];
  for (const chart of CHARTS) {
    const prepared = prepareChart(chart, index.points, { startMonth, endMonth });
    const svg = renderSvg(chart, prepared);
    const svgPath = join(OUT_DIR, chart.filename);
    const pngPath = join(OUT_DIR, pngFilename(chart.filename));
    await writeFile(svgPath, svg, "utf8");
    await writeFile(pngPath, svgToPng(svg));
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
  return new Resvg(svg, { fitTo: { mode: "width", value: CANVAS.width } }).render().asPng();
}

function pngFilename(filename) {
  return filename.replace(/\.svg$/i, ".png");
}

function prepareChart(chart, points, range) {
  const series = chart.series.map((definition) => {
    const rows = points
      .filter((point) => point.index_key === definition.key)
      .filter((point) => point.period_end_month >= range.startMonth && point.period_end_month <= range.endMonth)
      .filter((point) => point.price_index !== null && point.confidence !== "None")
      .sort((a, b) => a.period_end_month.localeCompare(b.period_end_month));
    const base = rows[0]?.price_index ?? null;
    return {
      ...definition,
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

function latestMonth(points) {
  return points.map((point) => point.period_end_month).filter(Boolean).sort().at(-1) ?? "2022-01";
}

function renderSvg(chart, prepared) {
  const W = CANVAS.width;
  const H = CANVAS.height;
  const n = prepared.series.length;
  const kicker = "SINGAPORE HDB · RESALE PULSE";
  const kickerY = MARGIN + 30;
  const titleLines = wrapText(chart.title, 31);
  const titleTop = kickerY + 52;
  const titleLineH = 50;
  const subTop = titleTop + (titleLines.length - 1) * titleLineH + 44;
  const subLines = wrapText(chart.subtitle, 65);
  const subLineH = 28;
  const headerBottom = subTop + (subLines.length - 1) * subLineH + 10;
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
  const panelPad = 22;

  const grid = [];
  for (let v = minY; v <= maxY + 1e-9; v += step) {
    const gy = y(v);
    const isBase = Math.abs(v - 100) < 1e-9;
    grid.push(`<line x1="${plotLeft}" y1="${gy}" x2="${plotRight}" y2="${gy}" stroke="${isBase ? "#cbb89a" : GRID}" stroke-width="${isBase ? 1.4 : 1}" ${isBase ? 'stroke-dasharray="5 5"' : ""}/>`);
    grid.push(`<text x="${plotLeft - 14}" y="${gy + 4}" text-anchor="end" font-size="17" fill="${isBase ? "#a9854d" : FAINT}" font-weight="${isBase ? 600 : 400}">${round(v, 0)}</text>`);
  }

  const xLabels = prepared.months
    .filter((m, i) => m.endsWith("-01") || i === prepared.months.length - 1)
    .map((m) => `<text x="${x(m)}" y="${plotBottom + 34}" text-anchor="middle" font-size="17" fill="${MUTED}">${m.endsWith("-01") ? m.slice(0, 4) : monthShort(m)}</text>`)
    .join("\n");

  const strokeW = n > 5 ? 3 : 3.8;
  const lines = prepared.series.map((s) => {
    const solid = s.points.length > 1
      ? `<polyline points="${s.points.map((p) => `${round(x(p.month), 1)},${round(y(p.rebased), 1)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="${strokeW}" stroke-opacity="${n > 5 ? 0.92 : 1}" stroke-linejoin="round" stroke-linecap="round"/>`
      : "";
    const last = s.points.at(-1);
    const dot = last
      ? `<circle cx="${round(x(last.month), 1)}" cy="${round(y(last.rebased), 1)}" r="5.5" fill="${s.color}" stroke="#ffffff" stroke-width="2.5"/>`
      : "";
    return solid + dot;
  }).join("\n");

  const colW = plotW / 2;
  const legend = prepared.series.map((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cx = plotLeft + col * colW;
    const cy = legendTopBaseline + row * legendRowH;
    const latest = s.points.at(-1);
    const value = latest ? round(latest.rebased, 1).toFixed(1) : "-";
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
  <text x="${MARGIN}" y="${kickerY}" font-size="19" font-weight="700" letter-spacing="3" fill="#2f6df0">${escapeXml(kicker)}</text>
  ${titleSvg}
  ${subSvg}
  <rect x="${plotLeft - panelPad + 5}" y="${plotTop - panelPad + 8}" width="${plotW + panelPad * 2}" height="${plotH + panelPad * 2}" rx="22" fill="#1f2430" opacity="0.05"/>
  <rect x="${plotLeft - panelPad}" y="${plotTop - panelPad}" width="${plotW + panelPad * 2}" height="${plotH + panelPad * 2}" rx="22" fill="${PANEL}"/>
  ${grid.join("\n")}
  ${lines}
  ${xLabels}
  ${legend}
  <text x="${MARGIN}" y="${footerY}" font-size="16" fill="${FAINT}">Source: data.gov.sg HDB resale transactions · Method: HDB soft matched-basket v0.1 · rebased to first 2022 point = 100</text>
</svg>
`;
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
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1).trimEnd()}...`;
}

function escapeXml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function printHelp() {
  console.log(`Render HDB market pulse charts

Usage:
  node research/hdb-market-pulse-index/render-hdb-charts.mjs [options]

Options:
  --index <path>              Index JSON path. Defaults to <out>/hdb-index-points.json
  --out <dir>                 Output directory. Defaults to ${DEFAULT_OUT_DIR}
  --start-month <YYYY-MM>     Chart start month. Defaults to index scope start_month
  --end-month <YYYY-MM>       Chart end month. Defaults to index scope end_month/latest point
  -h, --help                  Show this help
`);
}
