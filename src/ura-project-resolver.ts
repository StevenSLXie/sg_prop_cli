import { URA_PRIVATE_SALE_PROJECT_INDEX, type UraProjectIndexEntry } from "./ura-project-index.js";

export type UraProjectResolutionConfidence = "exact" | "normalized_exact" | "contains" | "ambiguous" | "unresolved";

export type UraResolvedProject = {
  input: string;
  matched_project: string;
  street?: string;
  district?: string;
  batch?: number;
  candidate_batches?: number[];
  confidence: UraProjectResolutionConfidence;
};

export type UraCandidatePlan = {
  batches: number[];
  resolved_projects: UraResolvedProject[];
  unresolved_inputs: string[];
  broad_scan_reason?: string;
};

export type ResolveUraSaleCandidatePlanInput = {
  projects?: string[];
  streets?: string[];
  districts?: string[];
  index?: UraProjectIndexEntry[];
};

const ALL_BATCHES = [1, 2, 3, 4];

export function resolveUraSaleCandidatePlan(input: ResolveUraSaleCandidatePlanInput): UraCandidatePlan {
  const index = input.index ?? URA_PRIVATE_SALE_PROJECT_INDEX;
  const districtBatches = uniqueSorted((input.districts ?? []).map(districtToBatch).filter((batch): batch is number => batch !== null));
  const resolvedProjects: UraResolvedProject[] = [];
  const unresolvedInputs: string[] = [];
  const resolvedBatches = new Set<number>();
  let hasAmbiguousInput = false;

  for (const project of input.projects ?? []) {
    const resolved = resolveProjectInput(project, "project", index);
    resolvedProjects.push(resolved);
    if (resolved.batch) resolvedBatches.add(resolved.batch);
    for (const batch of resolved.candidate_batches ?? []) resolvedBatches.add(batch);
    if (resolved.confidence === "unresolved") unresolvedInputs.push(project);
    if (resolved.confidence === "ambiguous") hasAmbiguousInput = true;
  }

  for (const street of input.streets ?? []) {
    const resolved = resolveProjectInput(street, "street", index);
    resolvedProjects.push(resolved);
    if (resolved.batch) resolvedBatches.add(resolved.batch);
    for (const batch of resolved.candidate_batches ?? []) resolvedBatches.add(batch);
    if (resolved.confidence === "unresolved") unresolvedInputs.push(street);
    if (resolved.confidence === "ambiguous") hasAmbiguousInput = true;
  }

  const projectBatches = uniqueSorted([...resolvedBatches]);
  let batches: number[];
  let broadScanReason: string | undefined;

  if (unresolvedInputs.length > 0) {
    batches = ALL_BATCHES;
    broadScanReason = "One or more project/street inputs could not be resolved to a URA batch.";
  } else if (hasAmbiguousInput && projectBatches.length === 0) {
    batches = ALL_BATCHES;
    broadScanReason = "One or more project/street inputs were ambiguous and did not resolve to a concrete batch.";
  } else if (districtBatches.length > 0 && projectBatches.length > 0) {
    batches = projectBatches.filter((batch) => districtBatches.includes(batch));
  } else if (projectBatches.length > 0) {
    batches = projectBatches;
  } else if (districtBatches.length > 0) {
    batches = districtBatches;
  } else {
    batches = ALL_BATCHES;
    broadScanReason = "No district, project, or street input was available to infer a URA batch.";
  }

  return {
    batches: uniqueSorted(batches),
    resolved_projects: resolvedProjects,
    unresolved_inputs: unresolvedInputs,
    ...(broadScanReason ? { broad_scan_reason: broadScanReason } : {})
  };
}

export function districtToBatch(district: string | number): number | null {
  const number = Number(String(district).trim());
  if (!Number.isInteger(number) || number < 1 || number > 28) return null;
  if (number <= 7) return 1;
  if (number <= 14) return 2;
  if (number <= 21) return 3;
  return 4;
}

export function normalizeUraLookupKey(value: string): string {
  return value
    .normalize("NFKD")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function resolveProjectInput(input: string, field: "project" | "street", index: UraProjectIndexEntry[]): UraResolvedProject {
  const normalizedInput = normalizeUraLookupKey(input);
  if (!normalizedInput) return unresolved(input);

  const exact = index.filter((entry) => entry[field].toUpperCase() === input.trim().toUpperCase());
  if (exact.length === 1) return resolved(input, exact[0]!, "exact");

  const normalizedExact = index.filter((entry) => normalizeUraLookupKey(entry[field]) === normalizedInput);
  if (normalizedExact.length === 1) return resolved(input, normalizedExact[0]!, "normalized_exact");
  if (normalizedExact.length > 1) return ambiguous(input, normalizedExact);

  const contains = index.filter((entry) => {
    const key = normalizeUraLookupKey(entry[field]);
    return key.includes(normalizedInput) || normalizedInput.includes(key);
  });
  if (contains.length === 1) return resolved(input, contains[0]!, "contains");
  if (contains.length > 1) return ambiguous(input, contains);

  return unresolved(input);
}

function resolved(input: string, entry: UraProjectIndexEntry, confidence: Exclude<UraProjectResolutionConfidence, "ambiguous" | "unresolved">): UraResolvedProject {
  return {
    input,
    matched_project: entry.project,
    street: entry.street,
    district: entry.district,
    batch: districtToBatch(entry.district) ?? undefined,
    confidence
  };
}

function ambiguous(input: string, entries: UraProjectIndexEntry[]): UraResolvedProject {
  const batches = uniqueSorted(entries.map((entry) => districtToBatch(entry.district)).filter((batch): batch is number => batch !== null));
  return {
    input,
    matched_project: entries.map((entry) => entry.project).join(" | "),
    street: entries.map((entry) => entry.street).join(" | "),
    district: entries.map((entry) => entry.district).join(" | "),
    batch: batches.length === 1 ? batches[0] : undefined,
    candidate_batches: batches.length > 1 ? batches : undefined,
    confidence: "ambiguous"
  };
}

function unresolved(input: string): UraResolvedProject {
  return {
    input,
    matched_project: "",
    confidence: "unresolved"
  };
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
