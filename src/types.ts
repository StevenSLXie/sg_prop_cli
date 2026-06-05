export type DistributionMode = "public" | "maintained" | "development";

export type SourceKey =
  | "hdb_resale_transactions"
  | "hdb_rental_transactions"
  | "hdb_median_resale"
  | "hdb_median_rent"
  | "hdb_block_profile"
  | "cea_salespersons"
  | "cea_residential_transactions"
  | "ura_private_residential_transactions"
  | "ura_private_residential_rentals"
  | "ura_private_rental_medians"
  | "ura_private_developer_sales"
  | "ura_private_transaction_volume"
  | "ura_private_price_index"
  | "ura_private_rental_index"
  | "ura_non_landed_rental_benchmark";

export type SourceCategory = "all" | "hdb" | "cea" | "ura" | "bca" | "sla" | "cpf";

export type Backend = "data_gov_sg" | "ura_data_service";

export type FieldType = "string" | "number" | "boolean" | "month" | "quarter";
export type FilterOperator = "eq" | "in" | "contains" | "gte" | "lte";

export type FieldCatalogEntry = {
  name: string;
  type: FieldType;
  filterable: boolean;
  operators: FilterOperator[];
  sortable: boolean;
  default_selected?: boolean;
  compact_priority?: number;
  enum_values?: string[];
  aliases?: string[];
  examples?: unknown[];
};

export type SourceDefinition = {
  source_key: SourceKey;
  category: Exclude<SourceCategory, "all">;
  display_name: string;
  description: string;
  backend: Backend;
  collection_id?: string;
  dataset_ids?: string[];
  ura_service?: string;
  requires_maintained_distribution: boolean;
  caveats: string[];
  fields: FieldCatalogEntry[];
};

export type FilterPrimitive = string | number | boolean;

export type FilterCondition =
  | FilterPrimitive
  | FilterPrimitive[]
  | {
      op: FilterOperator;
      value: FilterPrimitive | FilterPrimitive[];
    }
  | {
      gte?: string | number;
      lte?: string | number;
    };

export type HousingFilters = Record<string, FilterCondition>;

export type SourceAttribution = {
  source_key: SourceKey;
  name: string;
  backend: Backend;
  collection_id?: string;
  dataset_id?: string;
  ura_service?: string;
  url?: string;
};

export type ResponseMeta = {
  source_keys: SourceKey[];
  sources: SourceAttribution[];
  rows_returned?: number;
  rows_scanned?: number;
  pages_scanned?: number;
  batches_scanned?: number;
  backend_total?: number | null;
  complete?: boolean;
  truncated?: boolean;
  next_cursor?: string | null;
  caveats: string[];
  generated_at: string;
};

export type SuccessEnvelope<T> = {
  ok: true;
  tool: string;
  distribution_mode: DistributionMode;
  data: T;
  meta: ResponseMeta;
};

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "SOURCE_UNAVAILABLE"
  | "URA_REQUIRES_MAINTAINED_DISTRIBUTION"
  | "URA_AUTH_FAILED"
  | "URA_RATE_LIMITED"
  | "URA_SERVICE_UNAVAILABLE"
  | "DATA_GOV_RATE_LIMITED"
  | "DATA_GOV_UNAVAILABLE"
  | "PARTIAL_RANKING_REFUSED"
  | "SCAN_LIMIT_REACHED"
  | "INTERNAL_ERROR";

export type ErrorEnvelope = {
  ok: false;
  tool: string;
  distribution_mode: DistributionMode;
  error: {
    code: ErrorCode;
    message: string;
    recoverable: boolean;
    retry_after_seconds: number | null;
    affected_sources: SourceKey[];
    next_action: string;
    details?: Record<string, unknown>;
  };
  partial?: {
    data?: unknown;
    meta: ResponseMeta;
  };
};

export type ResultEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export type SummaryMeta = {
  summary_scope: "returned_rows" | "scanned_candidates" | "complete_matching_set";
  summary_rows_scanned: number;
  summary_sample_size: number;
  summary_complete: boolean;
  summary_truncated: boolean;
};
