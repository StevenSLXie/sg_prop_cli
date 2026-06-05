import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPackageUpdate, compareVersions } from "./update-check.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

const require = createRequire(import.meta.url);

const originalDisable = process.env.SG_HOUSING_DISABLE_UPDATE_CHECK;
const originalCacheHome = process.env.XDG_CACHE_HOME;
let tempCacheHome: string | null = null;

beforeEach(async () => {
  tempCacheHome = await mkdtemp(join(tmpdir(), "sg-housing-update-check-"));
  process.env.XDG_CACHE_HOME = tempCacheHome;
  delete process.env.SG_HOUSING_DISABLE_UPDATE_CHECK;
});

afterEach(async () => {
  if (originalDisable === undefined) delete process.env.SG_HOUSING_DISABLE_UPDATE_CHECK;
  else process.env.SG_HOUSING_DISABLE_UPDATE_CHECK = originalDisable;
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
  if (tempCacheHome) await rm(tempCacheHome, { recursive: true, force: true });
  tempCacheHome = null;
});

describe("package update check", () => {
  it("reads package identity from package.json", () => {
    const packageJson = require("../package.json") as { name: string; version: string };
    expect(PACKAGE_NAME).toBe(packageJson.name);
    expect(PACKAGE_VERSION).toBe(packageJson.version);
  });

  it("compares semantic versions numerically", () => {
    expect(compareVersions("0.10.0", "0.2.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
  });

  it("does not call the registry when update checks are disabled", async () => {
    process.env.SG_HOUSING_DISABLE_UPDATE_CHECK = "1";
    const result = await checkPackageUpdate({
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      }
    });

    expect(result.source).toBe("disabled");
    expect(result.update_available).toBe(false);
    expect(result.latest_version).toBeNull();
  });

  it("reports a newer npm version with an install command", async () => {
    const result = await checkPackageUpdate({
      now: new Date("2026-06-05T01:02:03.000Z"),
      fetchImpl: async () => new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 })
    });

    expect(result.source).toBe("network");
    expect(result.current_version).toBe(PACKAGE_VERSION);
    expect(result.latest_version).toBe("0.2.0");
    expect(result.update_available).toBe(true);
    expect(result.next_action).toBe("Run npm install -g sg-housing-data@latest");
  });

  it("uses a fresh cached registry response without fetching again", async () => {
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 });
    };

    await checkPackageUpdate({ now: new Date("2026-06-05T00:00:00.000Z"), fetchImpl });
    const cached = await checkPackageUpdate({
      now: new Date("2026-06-05T01:00:00.000Z"),
      fetchImpl: async () => {
        throw new Error("fresh cache should be used");
      }
    });

    expect(fetchCount).toBe(1);
    expect(cached.source).toBe("cache");
    expect(cached.latest_version).toBe("0.2.0");
  });
});
