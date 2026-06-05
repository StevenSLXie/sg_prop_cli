import { getCredentialStrategy } from "./credentials.js";
import type { FieldCatalogEntry, SourceCategory, SourceDefinition, SourceKey } from "./types.js";

export type ListedSource = Omit<SourceDefinition, "fields"> & {
  fields?: FieldCatalogEntry[];
  availability_status: "available" | "degraded" | "unavailable";
  validation_status: "unknown" | "ok" | "warning" | "unavailable";
  next_action?: string;
};

export type ListSourceOptions = {
  category?: SourceCategory;
  sourceKeys?: SourceKey[];
  includeFields?: boolean;
  includeEnumValues?: boolean;
  includeExamples?: boolean;
};

function field(
  name: string,
  type: FieldCatalogEntry["type"],
  operators: FieldCatalogEntry["operators"],
  options: Partial<FieldCatalogEntry> = {}
): FieldCatalogEntry {
  return {
    name,
    type,
    filterable: operators.length > 0,
    operators,
    sortable: type === "number" || type === "month" || type === "quarter",
    ...options
  };
}

export const SOURCES: SourceDefinition[] = [
  {
    source_key: "hdb_resale_transactions",
    category: "hdb",
    display_name: "HDB resale transactions",
    description: "HDB resale flat transaction rows from data.gov.sg.",
    backend: "data_gov_sg",
    collection_id: "189",
    dataset_ids: [
      "d_8b84c4ee58e3cfc0ece0d773c8ca6abc",
      "d_43f493c6c50d54243cc1eab0df142d6a",
      "d_2d5ff9ea31397b66239f245f57751537",
      "d_ebc5ab87086db484f88045b47411ebc5",
      "d_ea9ed51da2787afaf8e51f827c304208"
    ],
    requires_maintained_distribution: false,
    caveats: ["Pre-March 2012 and later records use different date bases.", "Not valuation advice."],
    fields: [
      field("month", "month", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 1 }),
      field("town", "string", ["eq", "in", "contains"], { default_selected: true, compact_priority: 2 }),
      field("flat_type", "string", ["eq", "in"], { default_selected: true, compact_priority: 3 }),
      field("block", "string", ["eq", "contains"], { default_selected: true, compact_priority: 4 }),
      field("street_name", "string", ["eq", "contains"], { default_selected: true, compact_priority: 5 }),
      field("storey_range", "string", ["eq", "in"], { default_selected: true, compact_priority: 6 }),
      field("floor_area_sqm", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 7 }),
      field("flat_model", "string", ["eq", "in"], { default_selected: true, compact_priority: 8 }),
      field("lease_commence_date", "number", ["eq", "gte", "lte"]),
      field("remaining_lease", "string", ["contains"]),
      field("remaining_lease_months", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 9 }),
      field("resale_price", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 10 })
    ]
  },
  {
    source_key: "hdb_rental_transactions",
    category: "hdb",
    display_name: "HDB rental transactions",
    description: "HDB public rental approval transaction rows from data.gov.sg.",
    backend: "data_gov_sg",
    collection_id: "166",
    dataset_ids: ["d_c9f57187485a850908655db0e8cfe651"],
    requires_maintained_distribution: false,
    caveats: ["Rows reflect public HDB rental approval records.", "Not rental valuation advice."],
    fields: [
      field("rent_approval_date", "month", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 1 }),
      field("town", "string", ["eq", "in", "contains"], { default_selected: true, compact_priority: 2 }),
      field("block", "string", ["eq", "contains"], { default_selected: true, compact_priority: 3 }),
      field("street_name", "string", ["eq", "contains"], { default_selected: true, compact_priority: 4 }),
      field("flat_type", "string", ["eq", "in"], { default_selected: true, compact_priority: 5 }),
      field("monthly_rent", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 6 })
    ]
  },
  {
    source_key: "hdb_median_resale",
    category: "hdb",
    display_name: "HDB median resale prices",
    description: "Quarterly median HDB resale prices by town and flat type from data.gov.sg.",
    backend: "data_gov_sg",
    collection_id: "157",
    dataset_ids: ["d_b51323a474ba789fb4cc3db58a3116d4"],
    requires_maintained_distribution: false,
    caveats: ["Summary source, not transaction-level evidence."],
    fields: [
      field("quarter", "quarter", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 1 }),
      field("town", "string", ["eq", "in"], { default_selected: true, compact_priority: 2 }),
      field("flat_type", "string", ["eq", "in"], { default_selected: true, compact_priority: 3 }),
      field("price", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 4 })
    ]
  },
  {
    source_key: "hdb_median_rent",
    category: "hdb",
    display_name: "HDB median rents",
    description: "Quarterly median HDB rents by town and flat type from data.gov.sg.",
    backend: "data_gov_sg",
    collection_id: "156",
    dataset_ids: ["d_23000a00c52996c55106084ed0339566"],
    requires_maintained_distribution: false,
    caveats: ["Summary source, not transaction-level evidence."],
    fields: [
      field("quarter", "quarter", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 1 }),
      field("town", "string", ["eq", "in"], { default_selected: true, compact_priority: 2 }),
      field("flat_type", "string", ["eq", "in"], { default_selected: true, compact_priority: 3 }),
      field("median_rent", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 4 })
    ]
  },
  {
    source_key: "hdb_block_profile",
    category: "hdb",
    display_name: "HDB block profile",
    description: "HDB block-level property information from data.gov.sg.",
    backend: "data_gov_sg",
    collection_id: "150",
    dataset_ids: ["d_17f5382f26140b1fdae0ba2ef6239d2f"],
    requires_maintained_distribution: false,
    caveats: ["Block profile source does not contain transaction prices."],
    fields: [
      field("blk_no", "string", ["eq"], { default_selected: true, compact_priority: 1, aliases: ["block"] }),
      field("street", "string", ["eq", "contains"], { default_selected: true, compact_priority: 2 }),
      field("max_floor_lvl", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 3 }),
      field("year_completed", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 4 }),
      field("residential", "boolean", ["eq"]),
      field("commercial", "boolean", ["eq"]),
      field("total_dwelling_units", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 5 })
    ]
  },
  {
    source_key: "cea_salespersons",
    category: "cea",
    display_name: "CEA active salespersons",
    description: "Active CEA salesperson registration records from data.gov.sg.",
    backend: "data_gov_sg",
    collection_id: "54",
    dataset_ids: ["d_07c63be0f37e6e59c07a4ddc2fd87fcb"],
    requires_maintained_distribution: false,
    caveats: ["Registration number is the strongest identifier. Name-only matches may be ambiguous."],
    fields: [
      field("salesperson_name", "string", ["eq", "contains"], { default_selected: true, compact_priority: 1 }),
      field("registration_no", "string", ["eq"], { default_selected: true, compact_priority: 2 }),
      field("registration_start_date", "string", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 3 }),
      field("registration_end_date", "string", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 4 }),
      field("estate_agent_name", "string", ["eq", "contains"], { default_selected: true, compact_priority: 5 }),
      field("estate_agent_license_no", "string", ["eq"], { default_selected: true, compact_priority: 6 })
    ]
  },
  {
    source_key: "cea_residential_transactions",
    category: "cea",
    display_name: "CEA residential transactions",
    description: "CEA salesperson residential transaction records for HDB/private sale and rental activity.",
    backend: "data_gov_sg",
    collection_id: "55",
    dataset_ids: ["d_ee7e46d3c57f7865790704632b0aef71"],
    requires_maintained_distribution: false,
    caveats: ["CEA transaction rows do not include transaction prices."],
    fields: [
      field("salesperson_name", "string", ["eq", "contains"], { default_selected: true, compact_priority: 1 }),
      field("transaction_date", "month", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 2 }),
      field("salesperson_reg_num", "string", ["eq"], { default_selected: true, compact_priority: 3 }),
      field("property_type", "string", ["eq", "in"], { default_selected: true, compact_priority: 4 }),
      field("transaction_type", "string", ["eq", "in"], { default_selected: true, compact_priority: 5 }),
      field("represented", "string", ["eq", "in"], { default_selected: true, compact_priority: 6 }),
      field("town", "string", ["eq", "in", "contains"], { default_selected: true, compact_priority: 7 }),
      field("district", "string", ["eq", "in"], { default_selected: true, compact_priority: 8 }),
      field("general_location", "string", ["eq", "contains"], { default_selected: true, compact_priority: 9 })
    ]
  },
  {
    source_key: "ura_private_residential_transactions",
    category: "ura",
    display_name: "URA private residential transactions",
    description: "Detailed URA private residential sale transaction rows from the past 5 years.",
    backend: "ura_data_service",
    ura_service: "PMI_Resi_Transaction",
    requires_maintained_distribution: true,
    caveats: ["No unit number is provided.", "Coordinates are project-level.", "Not valuation advice."],
    fields: [
      field("project", "string", ["eq", "contains"], { default_selected: true, compact_priority: 1 }),
      field("street", "string", ["eq", "contains"], { default_selected: true, compact_priority: 2 }),
      field("district", "string", ["eq", "in"], { default_selected: true, compact_priority: 3 }),
      field("market_segment", "string", ["eq", "in"], { default_selected: true, compact_priority: 4 }),
      field("contract_month", "month", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 5, aliases: ["contract_date", "contractDate", "date"] }),
      field("type_of_sale", "string", ["eq", "in"], { default_selected: true, compact_priority: 6 }),
      field("property_type", "string", ["eq", "in"], { default_selected: true, compact_priority: 7 }),
      field("area_sqm", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 8 }),
      field("price", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 9 }),
      field("price_psf", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 10 }),
      field("floor_range", "string", ["eq", "in"], { default_selected: true, compact_priority: 11 }),
      field("tenure", "string", ["eq", "contains"], { default_selected: true, compact_priority: 12 })
    ]
  },
  {
    source_key: "ura_private_residential_rentals",
    category: "ura",
    display_name: "URA private residential rentals",
    description: "Detailed URA private residential rental contract rows from the past 5 years.",
    backend: "ura_data_service",
    ura_service: "PMI_Resi_Rental",
    requires_maintained_distribution: true,
    caveats: ["Not rental valuation advice.", "Availability depends on approved URA credential strategy."],
    fields: [
      field("project", "string", ["eq", "contains"], { default_selected: true, compact_priority: 1 }),
      field("street", "string", ["eq", "contains"], { default_selected: true, compact_priority: 2 }),
      field("district", "string", ["eq", "in"], { default_selected: true, compact_priority: 3 }),
      field("ref_period", "quarter", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 4 }),
      field("property_type", "string", ["eq", "in"], { default_selected: true, compact_priority: 5 }),
      field("bedrooms", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 6 }),
      field("area_sqm", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 7 }),
      field("rent", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 8 })
    ]
  },
  {
    source_key: "ura_private_rental_medians",
    category: "ura",
    display_name: "URA private rental medians",
    description: "URA Data Service project-level private non-landed rental median records.",
    backend: "ura_data_service",
    ura_service: "PMI_Resi_Rental_Median",
    requires_maintained_distribution: true,
    caveats: ["Project-level median records, not individual rental contracts."],
    fields: [
      field("project", "string", ["eq", "contains"], { default_selected: true, compact_priority: 1 }),
      field("street", "string", ["eq", "contains"], { default_selected: true, compact_priority: 2 }),
      field("district", "string", ["eq", "in"], { default_selected: true, compact_priority: 3 }),
      field("ref_period", "quarter", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 4 }),
      field("median", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 5 })
    ]
  },
  {
    source_key: "ura_private_developer_sales",
    category: "ura",
    display_name: "URA private developer sales",
    description: "URA Data Service developer sales records for private residential projects.",
    backend: "ura_data_service",
    ura_service: "PMI_Resi_Developer_Sales",
    requires_maintained_distribution: true,
    caveats: ["New launch/developer sales context, not resale comparable analysis."],
    fields: [
      field("project", "string", ["eq", "contains"], { default_selected: true, compact_priority: 1 }),
      field("district", "string", ["eq", "in"], { default_selected: true, compact_priority: 2 }),
      field("market_segment", "string", ["eq", "in"], { default_selected: true, compact_priority: 3 }),
      field("ref_period", "month", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 4 }),
      field("median_price_psf", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 5 })
    ]
  },
  {
    source_key: "ura_non_landed_rental_benchmark",
    category: "ura",
    display_name: "URA non-landed rental benchmark",
    description: "data.gov.sg URA summary benchmark source for non-landed private residential rents.",
    backend: "data_gov_sg",
    collection_id: "1660",
    dataset_ids: ["d_149ac00a2734bb0a03867bbe2ec0e7b0"],
    requires_maintained_distribution: false,
    caveats: ["Summary source, not transaction-level evidence."],
    fields: [
      field("project", "string", ["eq", "contains"], { default_selected: true, compact_priority: 1 }),
      field("quarter", "quarter", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 2 }),
      field("median", "number", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 3 })
    ]
  },
  {
    source_key: "ura_private_transaction_volume",
    category: "ura",
    display_name: "URA private transaction volume",
    description: "data.gov.sg URA summary source for private residential transaction volume.",
    backend: "data_gov_sg",
    collection_id: "1658",
    dataset_ids: ["d_7c69c943d5f0d89d6a9a773d2b51f337"],
    requires_maintained_distribution: false,
    caveats: ["Summary source, not transaction-level evidence."],
    fields: [field("quarter", "quarter", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 1 })]
  },
  {
    source_key: "ura_private_price_index",
    category: "ura",
    display_name: "URA private price index",
    description: "data.gov.sg URA summary source for private residential price index.",
    backend: "data_gov_sg",
    collection_id: "1676",
    dataset_ids: ["d_97f8a2e995022d311c6c68cfda6d034c"],
    requires_maintained_distribution: false,
    caveats: ["Summary source, not transaction-level evidence."],
    fields: [field("quarter", "quarter", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 1 })]
  },
  {
    source_key: "ura_private_rental_index",
    category: "ura",
    display_name: "URA private rental index",
    description: "data.gov.sg URA summary source for private residential rental index.",
    backend: "data_gov_sg",
    collection_id: "1820",
    dataset_ids: ["d_8e4c50283fb7052a391dfb746a05c853"],
    requires_maintained_distribution: false,
    caveats: ["Summary source, not transaction-level evidence."],
    fields: [field("quarter", "quarter", ["eq", "gte", "lte"], { default_selected: true, compact_priority: 1 })]
  }
];

export function listSources(options: ListSourceOptions = {}): ListedSource[] {
  const category = options.category ?? "all";
  if (options.includeFields && category === "all" && (!options.sourceKeys || options.sourceKeys.length === 0)) {
    throw new Error("includeFields requires a narrow category or sourceKeys.");
  }

  const sourceKeySet = options.sourceKeys ? new Set(options.sourceKeys) : null;
  const filtered = SOURCES.filter((source) => {
    const categoryMatch = category === "all" || source.category === category;
    const sourceMatch = !sourceKeySet || sourceKeySet.has(source.source_key);
    return categoryMatch && sourceMatch;
  });

  return filtered.map((source) => {
    const { fields, ...rest } = source;
    const availability = sourceAvailability(source);
    if (!options.includeFields) return { ...rest, ...availability };
    return {
      ...rest,
      ...availability,
      fields: fields.map((fieldEntry) => ({
        ...fieldEntry,
        enum_values: options.includeEnumValues ? fieldEntry.enum_values : undefined,
        examples: options.includeExamples ? fieldEntry.examples : undefined
      }))
    };
  });
}

function sourceAvailability(source: SourceDefinition): Pick<ListedSource, "availability_status" | "validation_status" | "next_action"> {
  if (!source.requires_maintained_distribution) {
    return { availability_status: "available", validation_status: "unknown" };
  }
  const strategy = getCredentialStrategy();
  if (strategy.kind === "unavailable") {
    return {
      availability_status: "unavailable",
      validation_status: "unavailable",
      next_action: "Configure an approved URA credential strategy, such as URA_ACCESS_KEY for development or a maintained token broker."
    };
  }
  return { availability_status: "available", validation_status: "unknown" };
}

export function getSource(sourceKey: SourceKey): SourceDefinition | undefined {
  return SOURCES.find((source) => source.source_key === sourceKey);
}

export function requireSource(sourceKey: SourceKey): SourceDefinition {
  const source = getSource(sourceKey);
  if (!source) {
    throw new Error(`Unknown source: ${sourceKey}`);
  }
  return source;
}

export function compactFields(source: SourceDefinition): string[] {
  return source.fields
    .filter((field) => field.default_selected)
    .sort((a, b) => (a.compact_priority ?? 999) - (b.compact_priority ?? 999))
    .map((field) => field.name);
}

export function resolveFieldName(fields: FieldCatalogEntry[], fieldName: string): string {
  const direct = fields.find((field) => field.name === fieldName);
  if (direct) return direct.name;
  const alias = fields.find((field) => field.aliases?.includes(fieldName));
  return alias?.name ?? fieldName;
}

export function resolveFieldNames(fields: FieldCatalogEntry[], fieldNames: string[]): string[] {
  return fieldNames.map((fieldName) => resolveFieldName(fields, fieldName));
}

export function isSourceKey(value: string): value is SourceKey {
  return SOURCES.some((source) => source.source_key === value);
}
