import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { aggregateHousingRows } from "./aggregate.js";
import { getDistributionMode } from "./credentials.js";
import { isOk } from "./envelope.js";
import { queryHousingRows } from "./query.js";
import { listSources } from "./registry.js";
import { checkPackageUpdate } from "./update-check.js";
import { analyzePrivateResidentialSales } from "./ura-analysis.js";
import type { ResultEnvelope, SourceCategory, SourceKey } from "./types.js";
import {
  findPrivateResidentialRentalContracts,
  findPrivateResidentialSaleComparables,
  getPrivateDeveloperSales,
  getPrivateResidentialRentalMedians
} from "./ura-tools.js";
import { PACKAGE_VERSION } from "./version.js";

const sourceKeySchema = z.string().transform((value) => value as SourceKey);
const filtersSchema = z.record(z.string(), z.any()).optional();
const selectSchema = z.array(z.string()).optional();

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "sg-housing-data",
    version: PACKAGE_VERSION
  });

  server.registerTool(
    "list_housing_sources",
    {
      title: "List housing data sources",
      description:
        "List curated Singapore housing/property sources exposed by this MCP server, including availability, distribution mode, validation status, fields, filter operators, and caveats. Use this first to discover HDB, CEA, data.gov.sg, or URA Data Service sources; narrow source_keys before requesting fields.",
      inputSchema: {
        category: z.enum(["all", "hdb", "cea", "ura", "bca", "sla", "cpf"]).optional(),
        source_keys: z.array(sourceKeySchema).optional(),
        include_fields: z.boolean().optional(),
        include_enum_values: z.boolean().optional(),
        include_examples: z.boolean().optional()
      }
    },
    async (args) =>
      toolResult({
        ok: true,
        tool: "list_housing_sources",
        distribution_mode: getDistributionMode(),
        data: {
          sources: listSources({
            category: (args.category ?? "all") as SourceCategory,
            sourceKeys: args.source_keys,
            includeFields: args.include_fields,
            includeEnumValues: args.include_enum_values,
            includeExamples: args.include_examples
          })
        },
        meta: {
          source_keys: [],
          sources: [],
          caveats: [],
          generated_at: new Date().toISOString()
        }
      })
  );

  server.registerTool(
    "query_housing_rows",
    {
      title: "Query housing rows",
      description:
        "Return a small, bounded page of normalized compact rows from a curated housing source such as HDB resale transactions, CEA residential transactions, or URA summary datasets. Use for source evidence rows after narrowing with filters. For HDB resale recent-month evidence, prefer exact street_name/town/flat_type plus month_gte; common HDB street suffixes like Road->RD and Avenue->AVE are normalized before data.gov.sg filter pushdown, and recent rows are scanned first. Filters use field names with values for equality, arrays for in, {op:'contains'|'gte'|'lte',value}, or {gte,lte}; suffixes like month_gte and resale_price_lte are accepted. Not for unbounded full-table scans.",
      inputSchema: {
        source: sourceKeySchema,
        filters: filtersSchema,
        select: selectSchema,
        limit: z.number().int().positive().max(500).optional(),
        cursor: z.string().optional(),
        max_pages: z.number().int().positive().max(50).optional(),
        max_rows_scanned: z.number().int().positive().max(20000).optional(),
        include_raw: z.boolean().optional()
      }
    },
    async (args) => toolResult(await queryHousingRows(args))
  );

  server.registerTool(
    "aggregate_housing_rows",
    {
      title: "Aggregate housing rows",
      description:
        "Run bounded local aggregations over curated data.gov.sg housing sources: count, grouped count, top-N by count, or numeric summary. Use this before fetching rows for average, median, min/max, count, top-N, or 'by field' questions. numeric_summary supports group_by and returns capped grouped summaries using top_n. For HDB resale questions like average price by remaining lease, filter exact street_name/town/flat_type plus month_gte, group by remaining_lease_months or remaining_lease, and value_field resale_price. HDB street suffixes like Road->RD are normalized, exact filters are pushed to data.gov.sg, and recent HDB resale scans use newest records first. Returns completeness metadata and refuses authoritative partial rankings unless allow_partial is set.",
      inputSchema: {
        source: sourceKeySchema,
        filters: filtersSchema,
        operation: z.enum(["count", "group_count", "top_n_by_count", "numeric_summary"]),
        group_by: z.array(z.string()).optional(),
        value_field: z.string().optional(),
        top_n: z.number().int().positive().max(50).optional(),
        limit_rows_scanned: z.number().int().positive().max(20000).optional(),
        cursor: z.string().optional(),
        allow_partial: z.boolean().optional()
      }
    },
    async (args) => toolResult(await aggregateHousingRows(args))
  );

  server.registerTool(
    "check_package_update",
    {
      title: "Check package update",
      description:
        "Check whether a newer sg-housing-data npm package version is available. Use only for maintenance or update guidance when the user asks about setup, health, or upgrades. Returns current/latest versions and an install command; it does not auto-install and does not affect housing data queries.",
      inputSchema: {
        force: z.boolean().optional()
      }
    },
    async (args) =>
      toolResult({
        ok: true,
        tool: "check_package_update",
        distribution_mode: getDistributionMode(),
        data: await checkPackageUpdate({ force: args.force }),
        meta: {
          source_keys: [],
          sources: [],
          caveats: [],
          generated_at: new Date().toISOString()
        }
      })
  );

  server.registerTool(
    "find_private_residential_sale_comparables",
    {
      title: "Find private residential sale comparables",
      description:
        "Find a compact, bounded set of URA Data Service private residential sale transaction evidence rows from the past 5 years. Use for specific condo, apartment, EC, or landed comparable evidence by project, district, market segment, sale type, date, area, price, or PSF. For multi-project trend, quarterly comparison, segment, or metric-table questions, use analyze_private_residential_sales instead. For buyer shortlist questions like 'D18, budget 1.6-2.2m, 900-1200 sqft', convert sqft to sqm, set district/min_price/max_price/min_area_sqm/max_area_sqm, use output_mode='summary' or 'both', and read the capped project_summaries before fetching more rows. This tool calls URA batches, not data.gov.sg row scans, so it does not use the data.gov.sg pagination path. Requires an approved URA credential strategy. Not valuation advice; no unit number and coordinates are project-level.",
      inputSchema: privateSaleSchema()
    },
    async (args) => toolResult(await findPrivateResidentialSaleComparables(args))
  );

  server.registerTool(
    "analyze_private_residential_sales",
    {
      title: "Analyze private residential sales",
      description:
        "Analyze URA private residential sale transactions for multi-project, quarterly/monthly/yearly trend and segment comparisons in one call. Use this for questions like comparing several condo projects across six quarters, with all-vs-large-unit segments and metrics such as count, price_median, price_psf_median, and area_sqm_median. Project/street/district inputs are resolved to minimal URA sale batches before fetching; bedroom count is unavailable in URA sale data, so use explicit proxy assumptions such as area_sqm for 3-bedroom-or-larger analysis.",
      inputSchema: privateSalesAnalysisSchema()
    },
    async (args) => toolResult(await analyzePrivateResidentialSales(args))
  );

  server.registerTool(
    "find_private_residential_rental_contracts",
    {
      title: "Find private residential rental contracts",
      description:
        "Find compact, bounded URA Data Service private residential rental contract rows from the past 5 years. Use for private rental comparable questions by project, district, property type, bedrooms, reference quarter, area, or rent. Not rental valuation advice; requires an approved URA credential strategy.",
      inputSchema: privateRentalSchema()
    },
    async (args) => toolResult(await findPrivateResidentialRentalContracts(args))
  );

  server.registerTool(
    "get_private_residential_rental_medians",
    {
      title: "Get private residential rental medians",
      description:
        "Get compact URA Data Service project-level private non-landed rental median rows, including 25th percentile, median, and 75th percentile PSF rents where available. Use for project rental benchmarks when detailed contracts are unnecessary. Requires an approved URA credential strategy.",
      inputSchema: privateMedianSchema()
    },
    async (args) => toolResult(await getPrivateResidentialRentalMedians(args))
  );

  server.registerTool(
    "get_private_developer_sales",
    {
      title: "Get private developer sales",
      description:
        "Get compact URA Data Service developer sales rows for private residential projects, including launched/sold counts and low, median, and high price PSF. Use for new launch context, not resale comparable analysis. Requires an approved URA credential strategy.",
      inputSchema: privateDeveloperSchema()
    },
    async (args) => toolResult(await getPrivateDeveloperSales(args))
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

function commonPrivateSchema() {
  return {
    project: z.string().optional(),
    district: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
    select: selectSchema,
    include_raw: z.boolean().optional()
  };
}

function privateSaleSchema() {
  return {
    ...commonPrivateSchema(),
    street: z.string().optional(),
    market_segment: z.string().optional(),
    property_type: z.string().optional(),
    type_of_sale: z.enum(["new_sale", "sub_sale", "resale"]).optional(),
    min_area_sqm: z.number().optional(),
    max_area_sqm: z.number().optional(),
    min_price: z.number().optional(),
    max_price: z.number().optional(),
    min_price_psf: z.number().optional(),
    max_price_psf: z.number().optional(),
    floor_range: z.string().optional(),
    output_mode: z.enum(["rows", "summary", "both"]).optional()
  };
}

function privateSalesAnalysisSchema() {
  const segmentSchema = z.object({
    name: z.string(),
    filters: z.record(z.string(), z.any()).optional(),
    proxy_for: z.string().optional(),
    unavailable_field: z.string().optional(),
    proxy_field: z.string().optional(),
    note: z.string().optional()
  });
  return {
    project: z.string().optional(),
    projects: z.array(z.string()).optional(),
    street: z.string().optional(),
    streets: z.array(z.string()).optional(),
    district: z.string().optional(),
    districts: z.array(z.string()).optional(),
    market_segment: z.string().optional(),
    market_segments: z.array(z.string()).optional(),
    property_type: z.string().optional(),
    property_types: z.array(z.string()).optional(),
    type_of_sale: z.enum(["new_sale", "sub_sale", "resale"]).optional(),
    type_of_sales: z.array(z.enum(["new_sale", "sub_sale", "resale"])).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    min_area_sqm: z.number().optional(),
    max_area_sqm: z.number().optional(),
    min_price: z.number().optional(),
    max_price: z.number().optional(),
    min_price_psf: z.number().optional(),
    max_price_psf: z.number().optional(),
    floor_range: z.string().optional(),
    group_by: z.array(z.string()).optional(),
    segments: z.array(segmentSchema).optional(),
    metrics: z.array(z.string()).optional(),
    output: z.enum(["long_table", "wide_table"]).optional(),
    max_output_rows: z.number().int().positive().max(500).optional(),
    max_output_columns: z.number().int().positive().max(80).optional()
  };
}

function privateRentalSchema() {
  return {
    ...commonPrivateSchema(),
    street: z.string().optional(),
    property_type: z.string().optional(),
    bedrooms: z.number().int().optional(),
    min_area_sqm: z.number().optional(),
    max_area_sqm: z.number().optional(),
    min_rent: z.number().optional(),
    max_rent: z.number().optional(),
    output_mode: z.enum(["rows", "summary", "both"]).optional()
  };
}

function privateMedianSchema() {
  return {
    ...commonPrivateSchema()
  };
}

function privateDeveloperSchema() {
  return {
    project: z.string().optional(),
    district: z.string().optional(),
    market_segment: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
    select: selectSchema,
    include_raw: z.boolean().optional()
  };
}

function toolResult(result: ResultEnvelope<unknown>) {
  return {
    isError: !isOk(result),
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2)
      }
    ],
    structuredContent: result
  };
}
