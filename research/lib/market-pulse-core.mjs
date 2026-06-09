import { writeFile } from "node:fs/promises";

export function monthWindow(endMonth, count) {
  const months = [];
  for (let offset = count - 1; offset >= 0; offset--) months.push(addMonths(endMonth, -offset));
  return months;
}

export function addMonths(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function previousCompletedMonth(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const completed = new Date(Date.UTC(year, month - 1, 1));
  return `${completed.getUTCFullYear()}-${String(completed.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthsBetween(startMonth, endMonth) {
  const months = [];
  for (let month = startMonth; month <= endMonth; month = addMonths(month, 1)) months.push(month);
  return months;
}

export function rowsForMonths(rowsByMonth, months) {
  return months.flatMap((month) => rowsByMonth.get(month) ?? []);
}

export function groupRows(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const group = map.get(key);
    if (group) group.push(row);
    else map.set(key, [row]);
  }
  return map;
}

export function groupCounts(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return new Map([...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

export function groupSum(rows, keyFn, valueFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) ?? 0) + (valueFn(row) || 0));
  }
  return map;
}

export function capWeights(weightByKey, capShare) {
  const total = [...weightByKey.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0 || capShare <= 0) return new Map([...weightByKey.keys()].map((key) => [key, 0]));

  const absoluteCap = total * capShare;
  const capped = new Map();
  const remaining = new Map([...weightByKey.entries()].filter(([, value]) => value > 0));
  let remainingOriginalWeight = total;
  let remainingCappedWeight = total;

  while (remaining.size) {
    const newlyCapped = [];
    for (const [key, weight] of remaining.entries()) {
      const redistributedWeight = remainingOriginalWeight > 0 ? (remainingCappedWeight * weight) / remainingOriginalWeight : 0;
      if (redistributedWeight > absoluteCap) newlyCapped.push([key, weight]);
    }
    if (!newlyCapped.length) break;

    for (const [key, weight] of newlyCapped) {
      capped.set(key, absoluteCap);
      remaining.delete(key);
      remainingOriginalWeight -= weight;
      remainingCappedWeight -= absoluteCap;
    }
    if (remainingOriginalWeight <= 0 || remainingCappedWeight <= 0) break;
  }

  for (const [key, weight] of remaining.entries()) {
    const redistributedWeight = remainingOriginalWeight > 0 ? (remainingCappedWeight * weight) / remainingOriginalWeight : 0;
    capped.set(key, redistributedWeight);
  }
  return capped;
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index];
}

export function weightedMedian(items) {
  const sorted = items
    .filter((item) => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!sorted.length) return null;
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= totalWeight / 2) return item.value;
  }
  return sorted.at(-1).value;
}

export function weightedAverage(items, valueFn, weightFn) {
  let totalWeight = 0;
  let totalValue = 0;
  for (const item of items) {
    const value = valueFn(item);
    const weight = weightFn(item);
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) continue;
    totalValue += value * weight;
    totalWeight += weight;
  }
  return totalWeight ? totalValue / totalWeight : null;
}

export function weightedPercentile(items, valueFn, weightFn, p) {
  const sorted = items
    .map((item) => ({ value: valueFn(item), weight: weightFn(item) }))
    .filter((item) => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!sorted.length) return null;
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= totalWeight * p) return item.value;
  }
  return sorted.at(-1).value;
}

export function isValidMonth(month) {
  return /^\d{4}-\d{2}$/.test(month);
}

export function unique(values) {
  return [...new Set(values)];
}

export function objectFromMap(map) {
  return Object.fromEntries(map.entries());
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function nullableRound(value, digits) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : round(value, digits);
}

export function canonicalText(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  return `${[columns.join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))].join("\n")}\n`;
}

export function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}
