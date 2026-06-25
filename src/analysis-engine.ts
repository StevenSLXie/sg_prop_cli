export type AnalysisOutputMode = "long_table" | "wide_table";

export type AnalysisSegment<Row extends Record<string, unknown> = Record<string, unknown>> = {
  name: string;
  matches?: (row: Row) => boolean;
};

export type AnalysisEngineInput<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Iterable<Row>;
  groupBy: string[];
  segments: AnalysisSegment<Row>[];
  metrics: string[];
  output: AnalysisOutputMode;
  maxOutputRows: number;
  maxOutputColumns: number;
};

export type AnalysisEngineResult = {
  rows: Record<string, unknown>[];
  columns: string[];
};

type MetricStat = "min" | "max" | "avg" | "median" | "p25" | "p75";

type ParsedMetric =
  | {
      metric: "count";
      kind: "count";
    }
  | {
      metric: string;
      kind: "numeric";
      field: string;
      stat: MetricStat;
    };

type Bucket = {
  group: Record<string, unknown>;
  segment: string;
  segmentIndex: number;
  count: number;
  values: Record<string, number[]>;
};

const NUMERIC_SUFFIXES: MetricStat[] = ["median", "p25", "p75", "avg", "min", "max"];

export class AnalysisEngineError extends Error {
  constructor(
    public readonly code: "VALIDATION_ERROR",
    message: string
  ) {
    super(message);
  }
}

export function analyzeRows<Row extends Record<string, unknown>>(input: AnalysisEngineInput<Row>): AnalysisEngineResult {
  validateInput(input);
  const parsedMetrics = input.metrics.map(parseMetric);
  const segments = input.segments.length > 0 ? input.segments : [{ name: "all" }];
  const buckets = new Map<string, Bucket>();

  for (const row of input.rows) {
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const segment = segments[segmentIndex]!;
      if (segment.matches && !segment.matches(row)) continue;
      const group = Object.fromEntries(input.groupBy.map((field) => [field, row[field] ?? null]));
      const key = JSON.stringify({ group, segment: segment.name });
      const bucket = buckets.get(key) ?? {
        group,
        segment: segment.name,
        segmentIndex,
        count: 0,
        values: {}
      };
      bucket.count += 1;
      const numericFields = new Set(parsedMetrics.flatMap((metric) => (metric.kind === "numeric" ? [metric.field] : [])));
      for (const field of numericFields) {
        const value = toFiniteNumber(row[field]);
        if (value === null) continue;
        bucket.values[field] ??= [];
        bucket.values[field]!.push(value);
      }
      buckets.set(key, bucket);
    }
  }

  const sortedBuckets = [...buckets.values()].sort((left, right) => compareBuckets(left, right, input.groupBy));
  return input.output === "wide_table" ? materializeWide(sortedBuckets, parsedMetrics, input) : materializeLong(sortedBuckets, parsedMetrics, input);
}

function validateInput<Row extends Record<string, unknown>>(input: AnalysisEngineInput<Row>): void {
  const segmentNames = new Set<string>();
  for (const segment of input.segments) {
    if (!segment.name || !/^[A-Za-z0-9_ -]+$/.test(segment.name)) {
      throw new AnalysisEngineError("VALIDATION_ERROR", "Segment names must be non-empty and table-safe.");
    }
    if (segmentNames.has(segment.name)) {
      throw new AnalysisEngineError("VALIDATION_ERROR", `Duplicate segment name '${segment.name}'.`);
    }
    segmentNames.add(segment.name);
  }
  if (input.metrics.length === 0) {
    throw new AnalysisEngineError("VALIDATION_ERROR", "At least one metric is required.");
  }
  if (input.maxOutputRows < 1 || input.maxOutputRows > 500) {
    throw new AnalysisEngineError("VALIDATION_ERROR", "maxOutputRows must be between 1 and 500.");
  }
  if (input.maxOutputColumns < 1 || input.maxOutputColumns > 80) {
    throw new AnalysisEngineError("VALIDATION_ERROR", "maxOutputColumns must be between 1 and 80.");
  }
  for (const metric of input.metrics) {
    parseMetric(metric);
  }
}

function parseMetric(metric: string): ParsedMetric {
  if (metric === "count") return { metric, kind: "count" };
  for (const suffix of NUMERIC_SUFFIXES) {
    const marker = `_${suffix}`;
    if (metric.endsWith(marker) && metric.length > marker.length) {
      return {
        metric,
        kind: "numeric",
        field: metric.slice(0, -marker.length),
        stat: suffix
      };
    }
  }
  throw new AnalysisEngineError("VALIDATION_ERROR", `Unsupported analysis metric '${metric}'.`);
}

function materializeLong<Row extends Record<string, unknown>>(buckets: Bucket[], metrics: ParsedMetric[], input: AnalysisEngineInput<Row>): AnalysisEngineResult {
  if (buckets.length > input.maxOutputRows) {
    throw new AnalysisEngineError("VALIDATION_ERROR", `Analysis output would contain ${buckets.length} rows, above maxOutputRows ${input.maxOutputRows}.`);
  }
  const columns = [...input.groupBy, "segment", ...metrics.map((metric) => metric.metric)];
  if (columns.length > input.maxOutputColumns) {
    throw new AnalysisEngineError("VALIDATION_ERROR", `Analysis output would contain ${columns.length} columns, above maxOutputColumns ${input.maxOutputColumns}.`);
  }
  return {
    columns,
    rows: buckets.map((bucket) => ({
      ...bucket.group,
      segment: bucket.segment,
      ...Object.fromEntries(metrics.map((metric) => [metric.metric, materializeMetric(bucket, metric)]))
    }))
  };
}

function materializeWide<Row extends Record<string, unknown>>(buckets: Bucket[], metrics: ParsedMetric[], input: AnalysisEngineInput<Row>): AnalysisEngineResult {
  const groups = new Map<string, { group: Record<string, unknown>; buckets: Bucket[] }>();
  for (const bucket of buckets) {
    const key = JSON.stringify(bucket.group);
    const group = groups.get(key) ?? { group: bucket.group, buckets: [] };
    group.buckets.push(bucket);
    groups.set(key, group);
  }
  if (groups.size > input.maxOutputRows) {
    throw new AnalysisEngineError("VALIDATION_ERROR", `Analysis output would contain ${groups.size} rows, above maxOutputRows ${input.maxOutputRows}.`);
  }

  const metricColumns = input.segments.flatMap((segment) => metrics.map((metric) => `${safeColumnPrefix(segment.name)}_${metric.metric}`));
  const columns = [...input.groupBy, ...metricColumns];
  if (columns.length > input.maxOutputColumns) {
    throw new AnalysisEngineError("VALIDATION_ERROR", `Analysis output would contain ${columns.length} columns, above maxOutputColumns ${input.maxOutputColumns}.`);
  }

  const rows = [...groups.values()]
    .sort((left, right) => compareGroupObjects(left.group, right.group, input.groupBy))
    .map(({ group, buckets }) => {
      const row: Record<string, unknown> = { ...group };
      const bySegment = new Map(buckets.map((bucket) => [bucket.segment, bucket]));
      for (const segment of input.segments) {
        const bucket = bySegment.get(segment.name);
        for (const metric of metrics) {
          row[`${safeColumnPrefix(segment.name)}_${metric.metric}`] = bucket ? materializeMetric(bucket, metric) : null;
        }
      }
      return row;
    });

  return { columns, rows };
}

function materializeMetric(bucket: Bucket, metric: ParsedMetric): number | null {
  if (metric.kind === "count") return bucket.count;
  const values = bucket.values[metric.field] ?? [];
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (metric.stat === "min") return sorted[0]!;
  if (metric.stat === "max") return sorted[sorted.length - 1]!;
  if (metric.stat === "avg") return sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  if (metric.stat === "median") return percentile(sorted, 0.5);
  if (metric.stat === "p25") return percentile(sorted, 0.25);
  return percentile(sorted, 0.75);
}

function percentile(sorted: number[], p: number): number {
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function compareBuckets(left: Bucket, right: Bucket, groupBy: string[]): number {
  return compareGroupObjects(left.group, right.group, groupBy) || left.segmentIndex - right.segmentIndex;
}

function compareGroupObjects(left: Record<string, unknown>, right: Record<string, unknown>, groupBy: string[]): number {
  for (const field of groupBy) {
    const comparison = String(left[field] ?? "").localeCompare(String(right[field] ?? ""));
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeColumnPrefix(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "segment";
}
