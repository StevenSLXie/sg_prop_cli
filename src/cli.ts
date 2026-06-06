#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { aggregateHousingRows } from "./aggregate.js";
import { getCredentialStrategy, getDataGovStrategy, getDistributionMode } from "./credentials.js";
import { isOk } from "./envelope.js";
import { queryHousingRows } from "./query.js";
import { listSources } from "./registry.js";
import { startMcpServer } from "./mcp.js";
import { checkPackageUpdate } from "./update-check.js";
import type { HousingFilters, SourceCategory, SourceKey } from "./types.js";
import {
  findPrivateResidentialRentalContracts,
  findPrivateResidentialSaleComparables,
  getPrivateDeveloperSales,
  getPrivateResidentialRentalMedians
} from "./ura-tools.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

const program = new Command();

program
  .name("sg-housing")
  .description("Local CLI and MCP server for Singapore housing/property public data.")
  .version(PACKAGE_VERSION)
  .option("--json", "write JSON output");

program
  .command("sources")
  .description("List curated Singapore housing/property sources.")
  .option("--category <category>", "source category: all, hdb, cea, ura, bca, sla, cpf", "all")
  .option("--include-fields", "include compact field catalog")
  .option("--json", "write JSON output")
  .action((options: { category: SourceCategory; includeFields?: boolean; json?: boolean }) => {
    const payload = {
      ok: true,
      distribution_mode: getDistributionMode(),
      data: {
        sources: listSources({
          category: options.category,
          includeFields: Boolean(options.includeFields)
        })
      }
    };
    write(payload, options.json);
  });

program
  .command("rows")
  .description("Return a bounded compact page of rows from a curated data.gov.sg source.")
  .requiredOption("--source <source>", "source key")
  .option("--filter <key=value>", "simple equality filter; repeatable", collect, [])
  .option("--filters-json <json>", "advanced filters JSON with operators")
  .option("--select <fields>", "comma-separated normalized fields")
  .option("--limit <number>", "row limit, default 50, max 500", parseInteger)
  .option("--cursor <cursor>", "opaque cursor from previous call")
  .option("--max-pages <number>", "max backend pages to scan, max 50", parseInteger)
  .option("--max-rows-scanned <number>", "max backend rows to scan, max 20000", parseInteger)
  .option("--include-raw", "include raw backend row payload; requires limit <= 50")
  .option("--json", "write JSON output")
  .action(async (options: RowOptions) => {
    const result = await queryHousingRows({
      source: options.source as SourceKey,
      filters: parseFilters(options.filter, options.filtersJson),
      select: parseCsv(options.select),
      limit: options.limit,
      cursor: options.cursor,
      max_pages: options.maxPages,
      max_rows_scanned: options.maxRowsScanned,
      include_raw: options.includeRaw
    });
    write(result, options.json);
    if (!isOk(result)) process.exitCode = 1;
  });

program
  .command("aggregate")
  .description("Run bounded filtered aggregation over a curated data.gov.sg source.")
  .requiredOption("--source <source>", "source key")
  .requiredOption("--operation <operation>", "count, group_count, top_n_by_count, numeric_summary")
  .option("--filter <key=value>", "simple equality filter; repeatable", collect, [])
  .option("--filters-json <json>", "advanced filters JSON with operators")
  .option("--group-by <fields>", "comma-separated group fields; numeric_summary supports grouped summaries")
  .option("--value-field <field>", "numeric value field for numeric_summary, such as resale_price")
  .option("--top-n <number>", "top-N output size or grouped numeric summary cap, default 10, max 50", parseInteger)
  .option("--limit-rows-scanned <number>", "scan cap, default 5000, max 20000", parseInteger)
  .option("--cursor <cursor>", "opaque aggregation cursor")
  .option("--allow-partial", "allow partial top-N rankings")
  .option("--json", "write JSON output")
  .action(async (options: AggregateOptions) => {
    const result = await aggregateHousingRows({
      source: options.source as SourceKey,
      filters: parseFilters(options.filter, options.filtersJson),
      operation: options.operation,
      group_by: parseCsv(options.groupBy),
      value_field: options.valueField,
      top_n: options.topN,
      limit_rows_scanned: options.limitRowsScanned,
      cursor: options.cursor,
      allow_partial: options.allowPartial
    });
    write(result, options.json);
    if (!isOk(result)) process.exitCode = 1;
  });

const privateCommand = program.command("private").description("Private residential URA Data Service tools.");

privateCommand
  .command("sales")
  .description("Find bounded URA private residential sale comparable rows.")
  .option("--project <project>", "project name contains")
  .option("--street <street>", "street name contains")
  .option("--district <district>", "postal district")
  .option("--market-segment <segment>", "CCR, RCR, or OCR")
  .option("--property-type <type>", "property type")
  .option("--type-of-sale <type>", "new_sale, sub_sale, or resale")
  .option("--from <month>", "from contract month YYYY-MM")
  .option("--to <month>", "to contract month YYYY-MM")
  .option("--min-area-sqm <number>", "minimum area sqm", parseNumber)
  .option("--max-area-sqm <number>", "maximum area sqm", parseNumber)
  .option("--min-price <number>", "minimum price", parseNumber)
  .option("--max-price <number>", "maximum price", parseNumber)
  .option("--min-price-psf <number>", "minimum price psf", parseNumber)
  .option("--max-price-psf <number>", "maximum price psf", parseNumber)
  .option("--floor-range <range>", "floor range")
  .option("--limit <number>", "row limit, default 30, max 300", parseInteger)
  .option("--select <fields>", "comma-separated fields")
  .option("--include-raw", "include raw backend payload; requires limit <= 50")
  .option("--output-mode <mode>", "rows, summary, or both")
  .option("--json", "write JSON output")
  .action(async (options: PrivateOptions) => {
    const result = await findPrivateResidentialSaleComparables(privateOptions(options));
    write(result, options.json);
    if (!isOk(result)) process.exitCode = 1;
  });

privateCommand
  .command("rentals")
  .description("Find bounded URA private residential rental contract rows.")
  .option("--project <project>", "project name contains")
  .option("--street <street>", "street name contains")
  .option("--district <district>", "postal district")
  .option("--property-type <type>", "property type")
  .option("--bedrooms <number>", "bedroom count", parseInteger)
  .option("--from <quarter>", "from reference quarter YYYY-Qn")
  .option("--to <quarter>", "to reference quarter YYYY-Qn")
  .option("--quarter <quarter>", "single reference quarter YYYY-Qn")
  .option("--min-area-sqm <number>", "minimum area sqm", parseNumber)
  .option("--max-area-sqm <number>", "maximum area sqm", parseNumber)
  .option("--min-rent <number>", "minimum monthly rent", parseNumber)
  .option("--max-rent <number>", "maximum monthly rent", parseNumber)
  .option("--limit <number>", "row limit, default 30, max 300", parseInteger)
  .option("--select <fields>", "comma-separated fields")
  .option("--include-raw", "include raw backend payload; requires limit <= 50")
  .option("--output-mode <mode>", "rows, summary, or both")
  .option("--json", "write JSON output")
  .action(async (options: PrivateOptions) => {
    if (options.quarter) {
      options.from = options.quarter;
      options.to = options.quarter;
    }
    const result = await findPrivateResidentialRentalContracts(privateOptions(options));
    write(result, options.json);
    if (!isOk(result)) process.exitCode = 1;
  });

privateCommand
  .command("rental-medians")
  .description("Get URA private residential project rental medians.")
  .option("--project <project>", "project name contains")
  .option("--district <district>", "postal district")
  .option("--from <quarter>", "from reference quarter YYYY-Qn")
  .option("--to <quarter>", "to reference quarter YYYY-Qn")
  .option("--limit <number>", "row limit, default 50, max 500", parseInteger)
  .option("--select <fields>", "comma-separated fields")
  .option("--include-raw", "include raw backend payload; requires limit <= 50")
  .option("--json", "write JSON output")
  .action(async (options: PrivateOptions) => {
    const result = await getPrivateResidentialRentalMedians(privateOptions(options));
    write(result, options.json);
    if (!isOk(result)) process.exitCode = 1;
  });

privateCommand
  .command("developer-sales")
  .description("Get URA private residential developer sales rows.")
  .option("--project <project>", "project name contains")
  .option("--district <district>", "postal district")
  .option("--market-segment <segment>", "CCR, RCR, or OCR")
  .option("--limit <number>", "row limit, default 50, max 500", parseInteger)
  .option("--select <fields>", "comma-separated fields")
  .option("--include-raw", "include raw backend payload; requires limit <= 50")
  .option("--json", "write JSON output")
  .action(async (options: PrivateOptions) => {
    const result = await getPrivateDeveloperSales(privateOptions(options));
    write(result, options.json);
    if (!isOk(result)) process.exitCode = 1;
  });

program
  .command("update-check")
  .description("Check whether a newer sg-housing-data npm package version is available.")
  .option("--force", "ignore the local 24-hour version-check cache")
  .option("--json", "write JSON output")
  .action(async (options: { force?: boolean; json?: boolean }) => {
    write(
      {
        ok: true,
        distribution_mode: getDistributionMode(),
        data: await checkPackageUpdate({ force: options.force })
      },
      options.json
    );
  });

program
  .command("doctor")
  .description("Check local runtime and source availability without printing credentials.")
  .option("--mcp", "also verify that the local MCP stdio server can initialize and list tools")
  .option("--skip-update-check", "skip npm package update check")
  .option("--json", "write JSON output")
  .action(async (options: { mcp?: boolean; skipUpdateCheck?: boolean; json?: boolean }) => {
    const update = options.skipUpdateCheck ? null : await checkPackageUpdate();
    const credentialStrategy = getCredentialStrategy();
    const dataGovStrategy = getDataGovStrategy();
    const checks: DoctorCheck[] = [
      { name: "node", status: "ok", message: process.version },
      { name: "package", status: "ok", message: `${PACKAGE_NAME} ${PACKAGE_VERSION}` },
      await checkDataGovAccess(dataGovStrategy),
      {
        name: "ura_credentials",
        status: credentialStrategy.kind === "unavailable" ? "unavailable" : "ok",
        message:
          credentialStrategy.kind === "unavailable"
            ? "Detailed URA Data Service tools are unavailable in this mode."
            : "Approved URA credential strategy is configured.",
        next_action:
          credentialStrategy.kind === "unavailable"
            ? "Use public HDB/CEA/data.gov.sg sources, set URA_ACCESS_KEY for development, or use a maintained token broker."
            : undefined
      }
    ];
    if (update) {
      checks.push({
        name: "package_update",
        status: update.update_available || update.source === "error" ? "degraded" : "ok",
        message: update.message,
        next_action: update.next_action ?? undefined
      });
    }
    if (options.mcp) {
      checks.push(await checkMcpStdio());
    }
    const status = checks.some((check) => check.name === "mcp_stdio" && check.status === "unavailable")
      ? "unavailable"
      : checks.some((check) => check.status !== "ok")
        ? "degraded"
        : "ok";
    write(
      {
        ok: true,
        status,
        distribution_mode: getDistributionMode(),
        checks
      },
      options.json
    );
  });

program
  .command("mcp")
  .description("Start the local stdio MCP server.")
  .action(async () => {
    await startMcpServer();
  });

function write(payload: unknown, forceJson?: boolean): void {
  if (forceJson || program.opts().json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

type RowOptions = {
  source: string;
  filter: string[];
  filtersJson?: string;
  select?: string;
  limit?: number;
  cursor?: string;
  maxPages?: number;
  maxRowsScanned?: number;
  includeRaw?: boolean;
  json?: boolean;
};

type AggregateOptions = {
  source: string;
  operation: "count" | "group_count" | "top_n_by_count" | "numeric_summary";
  filter: string[];
  filtersJson?: string;
  groupBy?: string;
  valueField?: string;
  topN?: number;
  limitRowsScanned?: number;
  cursor?: string;
  allowPartial?: boolean;
  json?: boolean;
};

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFilters(simpleFilters: string[] = [], filtersJson?: string): HousingFilters | undefined {
  const parsed: HousingFilters = {};
  if (filtersJson) {
    const json = JSON.parse(filtersJson) as HousingFilters;
    Object.assign(parsed, json);
  }
  for (const item of simpleFilters) {
    const index = item.indexOf("=");
    if (index <= 0) throw new Error(`Invalid --filter '${item}', expected key=value.`);
    parsed[item.slice(0, index)] = coerceFilterValue(item.slice(index + 1));
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function coerceFilterValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  const numberValue = Number(value);
  if (value.trim() !== "" && !Number.isNaN(numberValue) && /^-?\d+(\.\d+)?$/.test(value)) return numberValue;
  return value;
}

type PrivateOptions = {
  project?: string;
  street?: string;
  district?: string;
  marketSegment?: string;
  propertyType?: string;
  typeOfSale?: "new_sale" | "sub_sale" | "resale";
  from?: string;
  to?: string;
  quarter?: string;
  minAreaSqm?: number;
  maxAreaSqm?: number;
  minPrice?: number;
  maxPrice?: number;
  minPricePsf?: number;
  maxPricePsf?: number;
  floorRange?: string;
  bedrooms?: number;
  minRent?: number;
  maxRent?: number;
  limit?: number;
  select?: string;
  includeRaw?: boolean;
  outputMode?: "rows" | "summary" | "both";
  json?: boolean;
};

type DoctorCheck = {
  name: string;
  status: "ok" | "degraded" | "unavailable";
  message: string;
  next_action?: string;
};

async function checkDataGovAccess(strategy: ReturnType<typeof getDataGovStrategy>): Promise<DoctorCheck> {
  if (strategy.kind === "direct_with_key") {
    return {
      name: "data_gov_credentials",
      status: "ok",
      message: "Direct data.gov.sg API key is configured."
    };
  }
  if (strategy.kind === "public_direct") {
    return {
      name: "data_gov_credentials",
      status: "degraded",
      message: "Using public data.gov.sg access without an API key.",
      next_action: "Use the maintained package/proxy or set DATA_GOV_SG_API_KEY with SG_HOUSING_DATA_GOV_DIRECT=1 for development."
    };
  }

  try {
    const response = await fetch(strategy.proxyUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      return {
        name: "data_gov_credentials",
        status: "unavailable",
        message: `Maintained data.gov.sg proxy returned HTTP ${response.status}.`,
        next_action: "Verify the Vercel data.gov.sg proxy is deployed and reachable."
      };
    }
    const payload = (await response.json()) as { configured?: unknown };
    return {
      name: "data_gov_credentials",
      status: payload.configured === true ? "ok" : "degraded",
      message:
        payload.configured === true
          ? "Maintained data.gov.sg proxy is configured with an API key."
          : "Maintained data.gov.sg proxy is reachable but DATA_GOV_SG_API_KEY is not configured.",
      next_action: payload.configured === true ? undefined : "Set DATA_GOV_SG_API_KEY on Vercel to use higher data.gov.sg rate limits."
    };
  } catch (error) {
    return {
      name: "data_gov_credentials",
      status: "unavailable",
      message: `Maintained data.gov.sg proxy health check failed: ${error instanceof Error ? error.message : String(error)}`,
      next_action: "Verify network access and the Vercel data.gov.sg proxy deployment."
    };
  }
}

async function checkMcpStdio(): Promise<DoctorCheck> {
  const cliPath = fileURLToPath(import.meta.url);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "mcp"], {
      env: { ...process.env, SG_HOUSING_DISABLE_UPDATE_CHECK: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish({
        name: "mcp_stdio",
        status: "unavailable",
        message: "MCP server did not respond to initialize/tools/list within 5 seconds.",
        next_action: "Run sg-housing mcp from Claude CLI config and inspect stderr for startup errors."
      });
    }, 5000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      evaluateMcpSmoke();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({
        name: "mcp_stdio",
        status: "unavailable",
        message: `MCP server could not start: ${error.message}`,
        next_action: "Verify Node.js is installed and sg-housing is available on PATH."
      });
    });
    child.on("exit", (code) => {
      if (!settled && code !== null) {
        finish({
          name: "mcp_stdio",
          status: "unavailable",
          message: `MCP server exited before completing smoke check with code ${code}.`,
          next_action: stderr.trim() || "Run sg-housing mcp directly to inspect startup errors."
        });
      }
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sg-housing-doctor", version: PACKAGE_VERSION } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    function send(message: unknown): void {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function evaluateMcpSmoke(): void {
      const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } };
          if (message.id === 2 && Array.isArray(message.result?.tools)) {
            finish({
              name: "mcp_stdio",
              status: stderr.trim().length > 0 ? "degraded" : "ok",
              message: `MCP server initialized and listed ${message.result.tools.length} tools.`,
              next_action: stderr.trim().length > 0 ? "Inspect stderr; MCP protocol output stayed on stdout but diagnostics were emitted." : undefined
            });
            return;
          }
        } catch {
          finish({
            name: "mcp_stdio",
            status: "degraded",
            message: "MCP server wrote non-JSON content to stdout during stdio smoke check.",
            next_action: "Remove stdout logging from MCP startup; diagnostics must go to stderr."
          });
          return;
        }
      }
    }

    function finish(check: DoctorCheck): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolve(check);
    }
  });
}

function privateOptions(options: PrivateOptions) {
  return {
    project: options.project,
    street: options.street,
    district: options.district,
    market_segment: options.marketSegment,
    property_type: options.propertyType,
    type_of_sale: options.typeOfSale,
    from: options.from,
    to: options.to,
    min_area_sqm: options.minAreaSqm,
    max_area_sqm: options.maxAreaSqm,
    min_price: options.minPrice,
    max_price: options.maxPrice,
    min_price_psf: options.minPricePsf,
    max_price_psf: options.maxPricePsf,
    floor_range: options.floorRange,
    bedrooms: options.bedrooms,
    min_rent: options.minRent,
    max_rent: options.maxRent,
    limit: options.limit,
    select: parseCsv(options.select),
    include_raw: options.includeRaw,
    output_mode: options.outputMode
  };
}

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
