/**
 * index.ts — Catalog Source Copy
 *
 * Main orchestrator that:
 * 1. Queries a Coveo catalog source via the Search API (Org A)
 * 2. Transforms the documents (field mapping, filtering, static fields)
 * 3. Streams the documents to a Coveo catalog source via the Stream API (Org B)
 *
 * Supports both product and availability document types as separate sources,
 * following the Metcash pattern.
 *
 * Usage:
 *   npx tsx src/index.ts                           # Full pipeline for all source types
 *   npx tsx src/index.ts --source products          # Products only
 *   npx tsx src/index.ts --source availability      # Availability only
 *   npx tsx src/index.ts --search-only              # Search & export only
 *   npx tsx src/index.ts --stream-only              # Stream from exported files
 *   npx tsx src/index.ts --dry-run                  # Search & transform, write sample (no stream)
 *   npx tsx src/index.ts --limit 100                # Limit to first N documents
 *   npx tsx src/index.ts --help                     # Show help
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { queryAllDocuments, writeExportFiles } from './search.js';
import { cleanSource, streamDocuments } from './stream.js';
import { transformDocuments } from './transform.js';
import type { Config, CoveoSearchResult, PipelineResult, SourceType } from './types.js';

// ─── Parse CLI arguments ────────────────────────────────────────────────────

const args = process.argv.slice(2);
let mode: 'full' | 'search-only' | 'stream-only' | 'clean' = 'full';
let dryRun = false;
let limit: number | null = null;
let sourceFilter: SourceType | 'all' = 'all';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case '--search-only':
      mode = 'search-only';
      break;
    case '--stream-only':
      mode = 'stream-only';
      break;
    case '--clean':
      mode = 'clean';
      break;
    case '--dry-run':
      dryRun = true;
      break;
    case '--limit': {
      const val = args[i + 1];
      limit = val ? parseInt(val, 10) : NaN;
      if (isNaN(limit) || limit <= 0) {
        console.error('❌ --limit must be a positive number');
        process.exit(1);
      }
      i++;
      break;
    }
    case '--source': {
      const val = args[i + 1] as SourceType | 'all' | undefined;
      if (!val || !['products', 'availability', 'all'].includes(val)) {
        console.error('❌ --source must be one of: products, availability, all');
        process.exit(1);
      }
      sourceFilter = val;
      i++;
      break;
    }
    case '--help':
    case '-h':
      console.log(`
Catalog Source Copy — Copy catalog data between Coveo organizations via the Stream API

Usage:
  npx tsx src/index.ts [options]

Options:
  --source <type>    Source type: products, availability, or all (default: all)
  --search-only      Only search & export documents to JSON (no stream)
  --stream-only      Stream from previously exported JSON files in export_output/
  --clean            Empty the destination source(s) — opens and immediately closes a stream
  --dry-run          Search & transform, write sample payload (skip actual stream)
  --limit <N>        Limit to first N documents per source type
  --debug            Enable debug logging (HTTP requests/responses)
  --help, -h         Show this help message

Configuration:
  Copy .config.example.json to .config.json and fill in your credentials.

Examples:
  npx tsx src/index.ts                                    # Full pipeline, all sources
  npx tsx src/index.ts --source products                  # Products only
  npx tsx src/index.ts --source availability              # Availability only
  npx tsx src/index.ts --clean                            # Empty all destination sources
  npx tsx src/index.ts --clean --source products          # Empty products source only
  npx tsx src/index.ts --search-only --source products    # Export products to JSON
  npx tsx src/index.ts --dry-run --limit 50               # Test with 50 docs, no stream
  npx tsx src/index.ts --stream-only                      # Stream from export_output/
`);
      process.exit(0);
  }
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const PROJECT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.resolve(PROJECT_DIR, '.config.json');
const EXPORT_BASE = path.resolve(PROJECT_DIR, 'export_output');

// ─── Load config ────────────────────────────────────────────────────────────

function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ Missing .config.json');
    console.error('   Copy .config.example.json to .config.json and fill in your credentials.');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;

  // Validate required fields
  if (!config.search?.org || !config.search?.apiKey) {
    console.error('❌ config.search requires org and apiKey');
    process.exit(1);
  }

  if (mode !== 'search-only' && !dryRun) {
    if (!config.stream?.org || !config.stream?.apiKey) {
      console.error('❌ config.stream requires org and apiKey');
      process.exit(1);
    }
  }

  // Defaults
  config.search.platform = config.search.platform || 'https://platform.cloud.coveo.com';
  config.search.numberOfResults = config.search.numberOfResults || 1000;

  config.stream = config.stream || ({} as Config['stream']);
  config.stream.batchSize = config.stream.batchSize || 500;
  config.stream.maxRetries = config.stream.maxRetries || 10;
  config.stream.retryAfter = config.stream.retryAfter || 5000;

  // Ensure transform sections have defaults
  for (const sourceType of ['products', 'availability'] as SourceType[]) {
    if (!config.transform[sourceType]) {
      config.transform[sourceType] = {
        fieldMapping: {},
        excludeFields: [],
        includeAllFields: true,
        documentIdField: 'documentId',
        titleField: 'title',
        staticFields: {},
      };
    }
    const t = config.transform[sourceType];
    t.fieldMapping = t.fieldMapping || {};
    t.excludeFields = t.excludeFields || [];
    t.includeAllFields = t.includeAllFields !== false;
    t.documentIdField = t.documentIdField || 'documentId';
    t.titleField = t.titleField || 'title';
    t.staticFields = t.staticFields || {};
  }

  return config;
}

// ─── Load exported files for stream-only mode ───────────────────────────────

function loadExportedResults(sourceType: SourceType): CoveoSearchResult[] {
  const exportDir = path.join(EXPORT_BASE, sourceType);
  if (!fs.existsSync(exportDir)) {
    console.error(`❌ No export_output/${sourceType}/ directory found. Run search first.`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(exportDir)
    .filter((f) => f.startsWith('export_') && f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.error(`❌ No export files found in export_output/${sourceType}/`);
    process.exit(1);
  }

  console.log(`📂 Loading ${files.length} export file(s) for ${sourceType}...`);
  let results: CoveoSearchResult[] = [];
  for (const file of files) {
    const data = JSON.parse(
      fs.readFileSync(path.join(exportDir, file), 'utf8'),
    ) as CoveoSearchResult[];
    results = results.concat(data);
  }
  console.log(`   Loaded ${results.length} documents from disk`);
  return results;
}

// ─── Run pipeline for a single source type ──────────────────────────────────

async function runPipeline(config: Config, sourceType: SourceType): Promise<PipelineResult> {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Pipeline: ${sourceType.toUpperCase()}`);
  console.log(`${'═'.repeat(50)}`);

  const sourceQuery = config.search.sources[sourceType];
  if (!sourceQuery) {
    console.log(`   ⚠️  No search.sources.${sourceType} configured — skipping`);
    return { searched: 0, transformed: 0, streamed: 0, failed: 0, dryRun };
  }

  const exportDir = path.join(EXPORT_BASE, sourceType);
  let searchResults: CoveoSearchResult[];

  // ── Step 1: Search ──
  if (mode === 'stream-only') {
    searchResults = loadExportedResults(sourceType);
  } else {
    searchResults = await queryAllDocuments(config, sourceQuery);

    if (limit && searchResults.length > limit) {
      searchResults = searchResults.slice(0, limit);
      console.log(`\n   ✂️  Limited to ${limit} documents`);
    }

    // Export raw search results to disk
    writeExportFiles(searchResults, exportDir);

    if (mode === 'search-only') {
      return { searched: searchResults.length, transformed: 0, streamed: 0, failed: 0, dryRun };
    }
  }

  // ── Step 2: Transform ──
  const transformConfig = config.transform[sourceType];
  const transformedDocs = transformDocuments(searchResults, transformConfig);

  if (transformedDocs.length === 0) {
    console.log('\n⚠️  No documents to stream after transformation.');
    return { searched: searchResults.length, transformed: 0, streamed: 0, failed: 0, dryRun };
  }

  // ── Step 3: Stream ──
  const streamSourceConfig = config.stream.sources[sourceType];
  if (!streamSourceConfig?.sourceId) {
    console.error(`❌ config.stream.sources.${sourceType}.sourceId is required`);
    process.exit(1);
  }

  const result = await streamDocuments(transformedDocs, config.stream, streamSourceConfig.sourceId, {
    dryRun,
  });

  return {
    searched: searchResults.length,
    transformed: transformedDocs.length,
    streamed: result.streamed,
    failed: result.failed,
    dryRun: result.dryRun,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════');
  console.log('  Catalog Source Copy');
  console.log(`  Mode: ${mode}${dryRun ? ' (dry run)' : ''}${limit && mode !== 'clean' ? ` (limit: ${limit})` : ''}`);
  console.log(`  Source: ${sourceFilter}`);
  console.log('═══════════════════════════════════════════════');

  const config = loadConfig();

  const sourceTypes: SourceType[] =
    sourceFilter === 'all' ? ['products', 'availability'] : [sourceFilter];

  // ── Clean mode ──
  if (mode === 'clean') {
    for (const sourceType of sourceTypes) {
      const streamSourceConfig = config.stream.sources[sourceType];
      if (!streamSourceConfig?.sourceId) {
        console.error(`❌ config.stream.sources.${sourceType}.sourceId is required`);
        process.exit(1);
      }
      await cleanSource(config.stream, streamSourceConfig.sourceId);
    }
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  Clean complete: ${sourceTypes.join(', ')}`);
    console.log(`${'═'.repeat(50)}`);
    return;
  }

  const results: Record<string, PipelineResult> = {};

  for (const sourceType of sourceTypes) {
    results[sourceType] = await runPipeline(config, sourceType);
  }

  // ── Summary ──
  console.log(`\n${'═'.repeat(50)}`);
  console.log('  Summary');
  console.log(`${'═'.repeat(50)}`);

  for (const [sourceType, result] of Object.entries(results)) {
    console.log(`\n  ${sourceType.toUpperCase()}:`);
    console.log(`    Documents found:       ${result.searched}`);
    console.log(`    Documents transformed: ${result.transformed}`);
    if (result.dryRun) {
      console.log(`    Stream:                DRY RUN (not streamed)`);
    } else if (mode !== 'search-only') {
      console.log(`    Documents streamed:    ${result.streamed}`);
      console.log(`    Documents failed:      ${result.failed}`);
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`\n❌ Fatal error: ${message}`);
  if (stack) console.error(stack);
  process.exit(1);
});
