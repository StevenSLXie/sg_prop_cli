import { getDistributionMode } from "./credentials.js";
import type {
  ErrorCode,
  ErrorEnvelope,
  ResponseMeta,
  ResultEnvelope,
  SourceAttribution,
  SourceDefinition,
  SourceKey,
  SuccessEnvelope
} from "./types.js";

export function sourceAttribution(source: SourceDefinition, dataset_id?: string): SourceAttribution {
  return {
    source_key: source.source_key,
    name: source.display_name,
    backend: source.backend,
    collection_id: source.collection_id,
    dataset_id,
    ura_service: source.ura_service
  };
}

export function baseMeta(sourceKeys: SourceKey[], sources: SourceAttribution[], caveats: string[] = []): ResponseMeta {
  return {
    source_keys: sourceKeys,
    sources,
    caveats,
    generated_at: new Date().toISOString()
  };
}

export function ok<T>(tool: string, data: T, meta: ResponseMeta): SuccessEnvelope<T> {
  return {
    ok: true,
    tool,
    distribution_mode: getDistributionMode(),
    data,
    meta
  };
}

export function fail(
  tool: string,
  code: ErrorCode,
  message: string,
  next_action: string,
  options: {
    recoverable?: boolean;
    retry_after_seconds?: number | null;
    affected_sources?: SourceKey[];
    details?: Record<string, unknown>;
    partial?: ErrorEnvelope["partial"];
  } = {}
): ErrorEnvelope {
  return {
    ok: false,
    tool,
    distribution_mode: getDistributionMode(),
    error: {
      code,
      message,
      recoverable: options.recoverable ?? false,
      retry_after_seconds: options.retry_after_seconds ?? null,
      affected_sources: options.affected_sources ?? [],
      next_action,
      details: options.details
    },
    partial: options.partial
  };
}

export function isOk<T>(result: ResultEnvelope<T>): result is SuccessEnvelope<T> {
  return result.ok;
}
