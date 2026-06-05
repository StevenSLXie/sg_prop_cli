import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

export type PackageUpdateStatus = {
  package_name: string;
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  checked_at: string | null;
  source: "disabled" | "cache" | "network" | "error";
  message: string;
  next_action: string | null;
};

type CachePayload = {
  checked_at: string;
  latest_version: string;
};

export type CheckPackageUpdateOptions = {
  force?: boolean;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: Date;
};

export async function checkPackageUpdate(options: CheckPackageUpdateOptions = {}): Promise<PackageUpdateStatus> {
  const now = options.now ?? new Date();
  if (process.env.SG_HOUSING_DISABLE_UPDATE_CHECK === "1") {
    return status(null, false, null, "disabled", "Package update check is disabled.", null);
  }

  const cached = options.force ? null : await readCache();
  if (cached && now.getTime() - new Date(cached.checked_at).getTime() < (options.cacheTtlMs ?? DEFAULT_TTL_MS)) {
    return fromLatest(cached.latest_version, cached.checked_at, "cache");
  }

  try {
    const latestVersion = await fetchLatestVersion(options.fetchImpl ?? fetch);
    const checkedAt = now.toISOString();
    await writeCache({ latest_version: latestVersion, checked_at: checkedAt });
    return fromLatest(latestVersion, checkedAt, "network");
  } catch (error) {
    if (cached) return fromLatest(cached.latest_version, cached.checked_at, "cache");
    return status(
      null,
      false,
      null,
      "error",
      `Package update check failed: ${error instanceof Error ? error.message : String(error)}`,
      null
    );
  }
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function fromLatest(latestVersion: string, checkedAt: string, source: "cache" | "network"): PackageUpdateStatus {
  const updateAvailable = compareVersions(latestVersion, PACKAGE_VERSION) > 0;
  return status(
    latestVersion,
    updateAvailable,
    checkedAt,
    source,
    updateAvailable
      ? `New ${PACKAGE_NAME} version available: ${PACKAGE_VERSION} -> ${latestVersion}.`
      : `${PACKAGE_NAME} is up to date.`,
    updateAvailable ? `Run npm install -g ${PACKAGE_NAME}@latest` : null
  );
}

function status(
  latestVersion: string | null,
  updateAvailable: boolean,
  checkedAt: string | null,
  source: PackageUpdateStatus["source"],
  message: string,
  nextAction: string | null
): PackageUpdateStatus {
  return {
    package_name: PACKAGE_NAME,
    current_version: PACKAGE_VERSION,
    latest_version: latestVersion,
    update_available: updateAvailable,
    checked_at: checkedAt,
    source,
    message,
    next_action: nextAction
  };
}

async function fetchLatestVersion(fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(REGISTRY_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const payload = (await response.json()) as { version?: unknown };
  if (typeof payload.version !== "string" || payload.version.length === 0) {
    throw new Error("npm registry response did not include version.");
  }
  return payload.version;
}

function parseVersion(version: string): number[] {
  return version
    .split("-", 1)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

async function readCache(): Promise<CachePayload | null> {
  try {
    const payload = JSON.parse(await readFile(cachePath(), "utf8")) as CachePayload;
    if (!payload.checked_at || !payload.latest_version) return null;
    return payload;
  } catch {
    return null;
  }
}

async function writeCache(payload: CachePayload): Promise<void> {
  try {
    const path = cachePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(payload), "utf8");
  } catch {
    // Update checks must never break normal CLI or MCP use.
  }
}

function cachePath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, PACKAGE_NAME, "version-check.json");
}
