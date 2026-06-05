import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { aggregateHousingRows } from "./aggregate.js";
import { getDistributionMode } from "./credentials.js";
import { isOk } from "./envelope.js";
import { queryHousingRows } from "./query.js";
import { listSources } from "./registry.js";
import { checkPackageUpdate } from "./update-check.js";
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
        "Return a small, bounded page of normalized compact rows from a curated housing source such as HDB resale transactions, CEA residential transactions, or URA summary datasets. Use for source evidence with filters, select, limits, scan caps, and cursors. Filters use field names with values for equality, arrays for in, {op:'contains'|'gte'|'lte',value}, or {gte,lte}; common suffixes like month_gte and resale_price_lte are also accepted. Not for unbounded full-table scans.",
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
        "Run bounded local aggregations over curated data.gov.sg housing sources: count, grouped count, top-N by count, or numeric summary. Use for questions like top CEA salespersons by town before fetching evidence rows. Filters use the same syntax as query_housing_rows, including _gte/_lte suffix compatibility. Returns completeness metadata and refuses authoritative partial rankings unless allow_partial is set.",
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
        "Find a compact, bounded set of URA Data Service private residential sale transaction rows from the past 5 years. Use for condo, apartment, EC, or landed comparable sale questions by project, district, market segment, sale type, date, area, price, or PSF. Requires an approved URA credential strategy. Not valuation advice; no unit number and coordinates are project-level.",
      inputSchema: privateSaleSchema()
    },
    async (args) => toolResult(await findPrivateResidentialSaleComparables(args))
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
