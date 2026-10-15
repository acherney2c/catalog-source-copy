/**
 * transform.ts — Transform Coveo Search API results into Stream API catalog documents
 *
 * Takes raw search results and transforms them into flat CatalogDocument objects
 * suitable for the Coveo Stream API. All metadata is placed at the top level
 * alongside documentId and title (no nested "metadata" key).
 *
 * Transformation is controlled by TransformConfig:
 * - fieldMapping:    { sourceField: targetField } — rename fields
 * - excludeFields:   [...] — fields to drop
 * - includeAllFields: true/false — if true, include all fields not in excludeFields
 * - documentIdField: which raw field to use as documentId (default: "documentId")
 * - titleField:      which raw/structural field to use as title (default: "title")
 * - staticFields:    { key: value } — constant fields added to every document
 */
import type { CatalogDocument, CoveoSearchResult, TransformConfig } from './types.js';

// Fields that are part of the Search API result structure (not raw metadata).
// These are handled specially and not forwarded as metadata.
const SEARCH_API_STRUCTURAL_FIELDS = new Set([
  'title',
  'uri',
  'printableUri',
  'clickUri',
  'uniqueId',
  'excerpt',
  'excerptHighlights',
  'firstSentences',
  'firstSentencesHighlights',
  'summary',
  'summaryHighlights',
  'titleHighlights',
  'flags',
  'hasHtmlVersion',
  'hasMobileHtmlVersion',
  'score',
  'percentScore',
  'rankingInfo',
  'isTopResult',
  'isRecommendation',
  'termsToHighlight',
  'phrasesToHighlight',
  'abHash',
  'index',
  'parentResult',
  'childResults',
  'totalNumberOfChildResults',
  'searchUid',
]);

// System fields that usually shouldn't be pushed to a new source
const DEFAULT_EXCLUDE_FIELDS = new Set([
  'sysconcepts',
  'sysindexeddate',
  'sysrowid',
  'syscollection',
  'syssource',
  'sysurihash',
  'syslanguage',
  'sysfiletype',
  'sysconnectortype',
  'syssite',
  'sysclickableuri',
  'sysprintableuri',
  'sysworkitemid',
  'sysparentid',
  'sysuri',
  'rowid',
  'urihash',
  'collection',
  'source',
  'indexeddate',
  'connectortype',
  'workitemid',
  'permanentid',
  // Push/Stream API reserved key names
  'orderingid',
  'fileid',
  'compressedbinarydata',
  'compressedbinarydatafileid',
  'fileextension',
  'parentid',
  'permissions',
]);

/**
 * Transform a single search result into a flat CatalogDocument for the Stream API.
 */
function transformDocument(
  searchResult: CoveoSearchResult,
  transformConfig: TransformConfig,
): CatalogDocument {
  const {
    fieldMapping = {},
    excludeFields = [],
    includeAllFields = true,
    documentIdField = 'documentId',
    titleField = 'title',
    staticFields = {},
  } = transformConfig;

  const excludeSet = new Set([
    ...DEFAULT_EXCLUDE_FIELDS,
    ...excludeFields.map((f) => f.toLowerCase()),
  ]);

  // Extract raw fields from the search result
  const raw = searchResult.raw || {};

  // Determine documentId — check raw first (catalog sources store it there),
  // then fall back to structural fields
  const documentId =
    (raw[documentIdField] as string | undefined) ??
    (searchResult[documentIdField] as string | undefined) ??
    searchResult.uri ??
    `unknown://${Date.now()}`;

  // Determine title
  const title =
    (raw[titleField] as string | undefined) ??
    (searchResult[titleField] as string | undefined) ??
    searchResult.title ??
    'Untitled';

  // Determine clickableUri
  const clickableUri =
    (raw['clickableuri'] as string | undefined) ??
    searchResult.clickUri ??
    documentId;

  // Build the flat document — start with required fields
  const doc: CatalogDocument = {
    documentId,
    title,
    clickableuri: clickableUri,
  };

  // Invert the field mapping for quick lookup: sourceLower -> targetField
  const mappingLookup = new Map<string, string>();
  for (const [source, target] of Object.entries(fieldMapping)) {
    mappingLookup.set(source.toLowerCase(), target);
  }

  // Process raw fields
  for (const [key, value] of Object.entries(raw)) {
    const lowerKey = key.toLowerCase();

    // Skip excluded fields
    if (excludeSet.has(lowerKey)) continue;

    // Skip null/undefined/empty values
    if (value === null || value === undefined || value === '') continue;

    // Skip fields that duplicate structural doc fields we already set
    if (lowerKey === 'documentid' || lowerKey === 'title' || lowerKey === 'clickableuri') continue;

    // Check if this field has a mapping
    const mappedTarget = mappingLookup.get(lowerKey);
    if (mappedTarget) {
      doc[mappedTarget] = value;
    } else if (includeAllFields) {
      // Include unmapped fields as-is
      doc[key] = value;
    }
    // If includeAllFields is false and field is not mapped, skip it
  }

  // Apply static fields (constants defined in config, override any existing)
  for (const [key, value] of Object.entries(staticFields)) {
    doc[key] = value;
  }

  // Add excerpt as searchable body text if available
  if (searchResult.excerpt) {
    doc['data'] = searchResult.excerpt;
  }

  return doc;
}

/**
 * Transform an array of search results into Stream API-compatible catalog documents.
 */
export function transformDocuments(
  searchResults: CoveoSearchResult[],
  transformConfig: TransformConfig,
): CatalogDocument[] {
  console.log(`\n🔄 Transforming ${searchResults.length} documents...`);

  const { fieldMapping = {}, excludeFields = [], includeAllFields, staticFields = {} } =
    transformConfig;
  console.log(`   Field mappings: ${Object.keys(fieldMapping).length}`);
  console.log(`   Static fields:  ${Object.keys(staticFields).length}`);
  console.log(`   Exclude fields: ${excludeFields.length + DEFAULT_EXCLUDE_FIELDS.size}`);
  console.log(`   Include all unmapped fields: ${includeAllFields !== false}`);
  console.log('');

  const transformed: CatalogDocument[] = [];
  let skipped = 0;

  for (const result of searchResults) {
    try {
      const doc = transformDocument(result, transformConfig);
      transformed.push(doc);
    } catch (err) {
      skipped++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`   ⚠️  Skipped document: ${message}`);
    }
  }

  console.log(`✅ Transformed ${transformed.length} documents (${skipped} skipped)`);

  // Log a sample of fields found
  if (transformed.length > 0) {
    const sampleFields = Object.keys(transformed[0]!);
    console.log(`\n   Sample fields (first doc): ${sampleFields.length} fields`);
    console.log(
      `   ${sampleFields.slice(0, 15).join(', ')}${sampleFields.length > 15 ? '...' : ''}`,
    );
  }

  return transformed;
}
