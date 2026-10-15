/**
 * types.ts — Shared interfaces and types for catalog source copy
 */

// ─── Source Types ────────────────────────────────────────────────────────────

export type SourceType = 'products' | 'availability';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface SourceQuery {
  query: string;
  pipeline: string;
}

export interface SearchConfig {
  org: string;
  apiKey: string;
  platform: string;
  numberOfResults: number;
  sources: Record<SourceType, SourceQuery>;
}

export interface StreamSourceConfig {
  sourceId: string;
}

export interface StreamConfig {
  platform: string;
  apiKey: string;
  org: string;
  batchSize: number;
  maxRetries: number;
  retryAfter: number;
  sources: Record<SourceType, StreamSourceConfig>;
}

export interface TransformConfig {
  fieldMapping: Record<string, string>;
  excludeFields: string[];
  includeAllFields: boolean;
  documentIdField: string;
  titleField: string;
  staticFields: Record<string, unknown>;
}

export interface Config {
  search: SearchConfig;
  stream: StreamConfig;
  transform: Record<SourceType, TransformConfig>;
}

// ─── Coveo Search API ────────────────────────────────────────────────────────

export interface CoveoSearchResult {
  title: string;
  uri: string;
  printableUri: string;
  clickUri: string;
  uniqueId: string;
  excerpt: string;
  score: number;
  percentScore: number;
  raw: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CoveoSearchResponse {
  totalCount: number;
  results: CoveoSearchResult[];
  searchUid: string;
  duration: number;
}

// ─── Catalog Documents (Stream API) ─────────────────────────────────────────

/**
 * A flat document for the Coveo Stream API.
 * `documentId` and `title` are required; all other fields are metadata
 * placed at the top level (not nested under a "metadata" key).
 */
export interface CatalogDocument {
  documentId: string;
  title: string;
  [key: string]: unknown;
}

export interface StreamChunkPayload {
  addOrUpdate: CatalogDocument[];
  delete: CatalogDocument[];
}

// ─── Stream API Responses ────────────────────────────────────────────────────

export interface OpenStreamResponse {
  streamId: string;
}

// ─── Pipeline Result ─────────────────────────────────────────────────────────

export interface PipelineResult {
  searched: number;
  transformed: number;
  streamed: number;
  failed: number;
  dryRun: boolean;
}
