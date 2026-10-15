/**
 * stream.ts — Push catalog documents to a Coveo Catalog source via the Stream API
 *
 * Uses coveo-pushapi-cli's StreamApi class which implements the correct
 * two-phase upload flow:
 *
 *   1. POST  /stream/open         → get streamId + pre-signed S3 uploadUri
 *   2. PUT   {uploadUri} (AWS S3) → upload first chunk payload
 *   3. POST  /stream/{id}/chunk   → get next pre-signed S3 uploadUri
 *   4. PUT   {uploadUri} (AWS S3) → upload next chunk payload
 *      (repeat 3–4 for every subsequent chunk)
 *   5. POST  /stream/{id}/close   → finalize; removes docs not in stream
 *
 * Document payload format: { AddOrUpdate: CatalogDocument[] }
 * Each document must have a `documentId` field (checked case-insensitively by the library).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CatalogDocument, PipelineResult, StreamChunkPayload, StreamConfig } from './types.js';

// ─── Types for the untyped coveo-pushapi-cli module ──────────────────────────

interface CoveoCliConfig {
  org: string;
  source: string;
  apiKey: string;
  platform: string;
  useStreamApi: boolean;
}

interface CoveoStreamApiInstance {
  openStream(): Promise<{ streamId: string; uploadUri: string }>;
  pushJsonPayload(data: { AddOrUpdate: CatalogDocument[] }): Promise<void>;
  closeStream(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StreamApi: CoveoStreamApi } = require('coveo-pushapi-cli') as {
  StreamApi: new (config: CoveoCliConfig) => CoveoStreamApiInstance;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract just the hostname from a platform URL.
 * StreamApi expects 'api-au.cloud.coveo.com', not 'https://api-au.cloud.coveo.com'
 */
function extractHostname(platform: string): string {
  return platform.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

// ─── High-level orchestrator ─────────────────────────────────────────────────

/**
 * Stream all documents to a Coveo Catalog source using coveo-pushapi-cli's StreamApi.
 *
 * Opens a stream, pushes documents in batches, then closes the stream.
 * On close, any documents NOT in the stream are removed from the source (full rebuild).
 */
export async function streamDocuments(
  documents: CatalogDocument[],
  config: StreamConfig,
  sourceId: string,
  options: { dryRun?: boolean } = {},
): Promise<PipelineResult> {
  const { batchSize = 500 } = config;
  const { dryRun = false } = options;

  console.log(`\n📤 Stream API Configuration:`);
  console.log(`   Organization: ${config.org}`);
  console.log(`   Source ID:    ${sourceId}`);
  console.log(`   Platform:     ${config.platform}`);
  console.log(`   Batch size:   ${batchSize}`);
  console.log(`   Documents:    ${documents.length}`);
  console.log(`   Dry run:      ${dryRun}`);
  console.log('');

  // ── Dry run ──
  if (dryRun) {
    const totalChunks = Math.ceil(documents.length / batchSize);
    console.log('🏁 DRY RUN — Skipping actual stream.');
    console.log(`   Total: ${documents.length} documents`);
    console.log(`   Chunks: ${totalChunks}`);

    const samplePayload: StreamChunkPayload = {
      addOrUpdate: documents.slice(0, 3),
      delete: [],
    };
    const outputDir = path.resolve(process.cwd(), 'export_output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const samplePath = path.join(outputDir, 'sample_stream_payload.json');
    fs.writeFileSync(samplePath, JSON.stringify(samplePayload, null, 2));
    console.log(`   Sample payload written to: ${samplePath}`);

    return { searched: 0, transformed: 0, streamed: 0, failed: 0, dryRun: true };
  }

  // ── Real stream ──
  const cliConfig: CoveoCliConfig = {
    org: config.org,
    source: sourceId,
    apiKey: config.apiKey,
    platform: extractHostname(config.platform),
    useStreamApi: true,
  };

  const api = new CoveoStreamApi(cliConfig);
  const totalChunks = Math.ceil(documents.length / batchSize);
  let streamed = 0;
  let failed = 0;

  try {
    // Step 1: Open stream — also uploads the first chunk's S3 URI
    console.log('🔄 Opening stream...');
    await api.openStream();
    console.log('   ✓ Stream opened');

    // Step 2: Push chunks
    // First batch uses the uploadUri from openStream;
    // subsequent batches call POST /chunk to get a fresh S3 URI each time.
    for (let i = 0; i < totalChunks; i++) {
      const batchStart = i * batchSize;
      const batchEnd = Math.min(batchStart + batchSize, documents.length);
      const batch = documents.slice(batchStart, batchEnd);

      console.log(`\n📦 Chunk ${i + 1}/${totalChunks} (${batch.length} documents)...`);

      try {
        await api.pushJsonPayload({ AddOrUpdate: batch });
        streamed += batch.length;
        console.log(`   ✓ Chunk ${i + 1} uploaded (${streamed}/${documents.length})`);
      } catch (err) {
        failed += batch.length;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`   ✗ Chunk ${i + 1} failed: ${message}`);
      }
    }

    // Step 3: Close stream
    console.log('\n🔄 Closing stream...');
    await api.closeStream();
    console.log('   ✓ Stream closed — source will update shortly');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Stream error: ${message}`);
    throw err;
  }

  console.log(`\n✅ Stream complete: ${streamed} streamed, ${failed} failed`);
  return { searched: 0, transformed: 0, streamed, failed, dryRun: false };
}

/**
 * Clean a Coveo Catalog source by opening a stream, pushing an empty AddOrUpdate
 * payload, then closing it. Coveo rebuilds the source with no documents.
 *
 * Uses direct HTTP calls (not coveo-pushapi-cli) so we fully control the payload.
 * Stream API flow:
 *   POST /stream/open          → { streamId, uploadUri }
 *   PUT  {uploadUri} (S3)      → empty batch { AddOrUpdate: [] }
 *   POST /stream/{id}/close    → source emptied
 */
export async function cleanSource(config: StreamConfig, sourceId: string): Promise<void> {
  console.log(`\n🧹 Cleaning source:`);
  console.log(`   Organization: ${config.org}`);
  console.log(`   Source ID:    ${sourceId}`);
  console.log(`   Platform:     ${config.platform}`);
  console.log('');

  const hostname = extractHostname(config.platform);
  const pushBase = `https://${hostname}/push/v1/organizations/${config.org}/sources/${sourceId}`;
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };

  // Step 1: Open stream
  console.log('🔄 Opening stream...');
  const openRes = await fetch(`${pushBase}/stream/open`, { method: 'POST', headers });
  if (!openRes.ok) {
    throw new Error(`Stream open failed (${openRes.status}): ${await openRes.text()}`);
  }
  const { streamId, uploadUri } = (await openRes.json()) as { streamId: string; uploadUri: string };
  console.log(`   ✓ Stream opened (id: ${streamId})`);

  // Step 2: Upload empty JSON file to S3 — signals Coveo to delete all content
  console.log('📦 Uploading empty JSON to S3...');
  const s3Res = await fetch(uploadUri, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-amz-server-side-encryption': 'AES256',
    },
    body: '{}',
  });
  if (!s3Res.ok) {
    throw new Error(`S3 upload failed (${s3Res.status}): ${await s3Res.text()}`);
  }
  console.log('   ✓ Empty JSON uploaded');

  // Step 3: Close stream — Coveo rebuilds source with zero documents
  console.log('🔄 Closing stream...');
  const closeRes = await fetch(`${pushBase}/stream/${streamId}/close`, { method: 'POST', headers });
  if (!closeRes.ok) {
    throw new Error(`Stream close failed (${closeRes.status}): ${await closeRes.text()}`);
  }
  console.log('   ✓ Stream closed — source will be emptied shortly');
}
