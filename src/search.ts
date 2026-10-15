/**
 * search.ts — Query Coveo Search API and paginate through all results
 *
 * Uses the Coveo Search API v2 to retrieve ALL matching documents with ALL their fields.
 * Paginates using @rowid cursor from the first page — sort by @rowid ascending,
 * use each page's last rowid as a "greater than" filter for the next page.
 * Since rowid is unique per document there are no cursor collisions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Config, CoveoSearchResponse, CoveoSearchResult, SourceQuery } from './types.js';

const DEBUG = process.env['DEBUG'] === '1' || process.argv.includes('--debug');

/**
 * Query all documents matching the configured query using rowid cursor pagination.
 */
export async function queryAllDocuments(
  config: Config,
  sourceQuery: SourceQuery,
): Promise<CoveoSearchResult[]> {
  const pageSize = config.search.numberOfResults || 1000;
  const { org, apiKey, platform } = config.search;
  const searchUrl = `${platform}/rest/search/v2?organizationId=${org}`;

  console.log(`\n🔍 Querying Coveo Search API...`);
  console.log(`   Organization: ${org}`);
  console.log(`   Query: ${sourceQuery.query}`);
  console.log(`   Pipeline: ${sourceQuery.pipeline || '(default)'}`);
  console.log(`   Platform: ${platform}`);
  console.log(`   Page size: ${pageSize}`);
  console.log('');

  const allResults: CoveoSearchResult[] = [];
  let lastRowId: number | null = null;
  let totalCount: number | null = null;
  let page = 0;
  const maxPages = 300; // Safety limit (300 × 1000 = 300k docs max)

  while (page < maxPages) {
    const cursorFilter = lastRowId !== null ? `@rowid>${lastRowId}` : '';
    const aq = cursorFilter ? `${sourceQuery.query} ${cursorFilter}` : sourceQuery.query;

    const body = {
      q: '',
      aq,
      numberOfResults: pageSize,
      firstResult: 0,
      sortCriteria: 'fieldascending',
      sortField: '@rowid',
      pipeline: sourceQuery.pipeline || '',
    };

    if (DEBUG) {
      console.log(`\n── DEBUG: Request (page ${page + 1}) ──`);
      console.log(`   cursor (lastRowId): ${lastRowId}`);
      console.log(`   Body:\n${JSON.stringify(body, null, 2)}`);
    }

    const response = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Search API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as CoveoSearchResponse;

    if (totalCount === null) {
      totalCount = data.totalCount;
      console.log(`   Total documents found: ${totalCount}`);
      console.log('');
    }

    if (DEBUG) {
      console.log(`   Response totalCount: ${data.totalCount}, results: ${data.results?.length ?? 0}`);
    }

    const results = data.results || [];
    if (results.length === 0) break;

    allResults.push(...results);
    console.log(`   Fetched ${results.length} (total: ${allResults.length} / ${totalCount})`);

    // Advance cursor
    const lastResult = results[results.length - 1]!;
    const raw = lastResult.raw?.['rowid'] ?? lastResult.raw?.['sysrowid'];
    if (typeof raw === 'number') lastRowId = raw;
    else if (typeof raw === 'string') lastRowId = parseInt(raw, 10) || lastRowId;
    else console.warn('   ⚠️  Could not read rowid from last result — cursor may repeat documents');

    if (results.length < pageSize) break;

    page++;
  }

  console.log(`\n✅ Search complete: ${allResults.length} documents retrieved`);
  return allResults;
}

/**
 * Write raw search results to JSON files for inspection / later use
 */
export function writeExportFiles(
  results: CoveoSearchResult[],
  outputDir: string,
  batchSize: number = 1000,
): void {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Clean old exports
  const oldFiles = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'));
  oldFiles.forEach((f) => fs.unlinkSync(path.join(outputDir, f)));

  const totalBatches = Math.ceil(results.length / batchSize);

  for (let i = 0; i < totalBatches; i++) {
    const batch = results.slice(i * batchSize, (i + 1) * batchSize);
    const filename = path.join(outputDir, `export_${String(i + 1).padStart(4, '0')}.json`);
    fs.writeFileSync(filename, JSON.stringify(batch, null, 2));
    console.log(`   Wrote ${batch.length} documents to ${path.basename(filename)}`);
  }

  console.log(`\n📁 Exported ${results.length} documents to ${totalBatches} file(s) in ${outputDir}`);
}
