# Catalog Source Copy

Copy documents from a Coveo **catalog source** in one organization to a catalog source in another organization using the **Stream API**.

Supports both **product** and **availability** document types as separate catalog sources (e.g. the Metcash/Campbells pattern).

## Architecture

```
┌──────────────────────┐     ┌──────────────────┐     ┌───────────────────────┐
│  Coveo Search API v2 │────▶│   Transform      │────▶│  Coveo Stream API     │
│  (source org)        │     │  (field mapping)  │     │  (destination org)    │
└──────────────────────┘     └──────────────────┘     └───────────────────────┘
      search.ts                 transform.ts                stream.ts
```

**Flow:**
1. **Search** — Query the source org's Search API with pagination (handles >5000 results via date-windowing)
2. **Export** — Write raw search results to `export_output/{products,availability}/` as JSON batches
3. **Transform** — Rename/filter/add fields based on per-source-type transform config
4. **Stream** — Open a stream → push document chunks → close the stream (atomic full rebuild)

## Quick Start

1. **Install dependencies**
   ```bash
   cd catalogcopy/catalog_source_copy
   npm install
   ```

2. **Configure credentials**

   Copy the example config and fill in your values:
   ```bash
   cp .config.example.json .config.json
   ```

   Edit `.config.json` — see [Configuration](#configuration) below.

3. **Run**

   ```bash
   # Full pipeline: search → transform → stream (all source types)
   npm start

   # Products only
   npx tsx src/index.ts --source products

   # Availability only
   npx tsx src/index.ts --source availability

   # Search only (export to JSON, no stream)
   npm run search

   # Dry run (search + transform + sample payload, no stream)
   npm run dry-run

   # Stream from previously exported files
   npm run stream

   # Limit documents
   npx tsx src/index.ts --dry-run --limit 50 --source products
   ```

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Full pipeline: search → transform → stream (all sources) |
| `npm run search` | Search & export only (no stream) |
| `npm run stream` | Stream from `export_output/` files |
| `npm run dry-run` | Search & transform, write sample payload |
| `--source products` | Process only product documents |
| `--source availability` | Process only availability documents |
| `--source all` | Process both (default) |
| `--limit N` | Limit to N documents per source type |
| `--debug` | Verbose HTTP logging |

## Configuration

### `.config.json` structure

```jsonc
{
  "search": {
    // Source organization (where to read documents FROM)
    "org": "source-org-id",
    "apiKey": "search-api-key-with-query-access",
    "platform": "https://platform-au.cloud.coveo.com",
    "numberOfResults": 1000,  // results per page (max 1000)
    "sources": {
      "products": {
        "query": "@objecttype==product",    // search query for products
        "pipeline": ""                       // query pipeline (optional)
      },
      "availability": {
        "query": "@objecttype==availability",
        "pipeline": ""
      }
    }
  },
  "stream": {
    // Destination organization (where to WRITE documents TO)
    "platform": "https://api-au.cloud.coveo.com",
    "apiKey": "api-key-with-push-privileges",
    "org": "destination-org-id",
    "batchSize": 500,     // documents per stream chunk
    "maxRetries": 10,     // retries on 429/5xx
    "retryAfter": 5000,   // initial retry delay (ms), doubles on each retry
    "sources": {
      "products": {
        "sourceId": "destination-product-catalog-source-id"
      },
      "availability": {
        "sourceId": "destination-availability-catalog-source-id"
      }
    }
  },
  "transform": {
    // Per-source-type transform configuration
    "products": {
      "fieldMapping": {},           // { "sourceField": "targetField" }
      "excludeFields": [],          // additional fields to drop
      "includeAllFields": true,     // include all non-excluded fields
      "documentIdField": "documentId",
      "titleField": "title",
      "staticFields": {             // constant fields added to every doc
        "objecttype": "product"
      }
    },
    "availability": {
      "fieldMapping": {},
      "excludeFields": [],
      "includeAllFields": true,
      "documentIdField": "documentId",
      "titleField": "title",
      "staticFields": {
        "objecttype": "availability"
      }
    }
  }
}
```

### `search` — Source org query settings

| Key | Description | Default |
|-----|-------------|---------|
| `org` | Source Coveo organization ID | *required* |
| `apiKey` | Search API key with query access | *required* |
| `platform` | Coveo Platform URL (search endpoint) | `https://platform.cloud.coveo.com` |
| `numberOfResults` | Results per page (max 1000) | `1000` |
| `sources.{type}.query` | Search query for this source type | *required* |
| `sources.{type}.pipeline` | Query pipeline name | `""` |

### `stream` — Destination org stream settings

| Key | Description | Default |
|-----|-------------|---------|
| `platform` | Coveo Push/Stream API URL | *required* |
| `apiKey` | API key with push privileges | *required* |
| `org` | Destination Coveo organization ID | *required* |
| `batchSize` | Documents per stream chunk | `500` |
| `maxRetries` | Max retries on 429/5xx | `10` |
| `retryAfter` | Initial retry delay (ms) | `5000` |
| `sources.{type}.sourceId` | Destination catalog source ID | *required* |

### `transform` — Field transformation (per source type)

| Key | Description | Default |
|-----|-------------|---------|
| `fieldMapping` | `{ sourceField: targetField }` renames | `{}` |
| `excludeFields` | Array of additional field names to drop | `[]` |
| `includeAllFields` | Include all fields not excluded | `true` |
| `documentIdField` | Raw field to use as documentId | `"documentId"` |
| `titleField` | Raw field to use as title | `"title"` |
| `staticFields` | Constants added to every document | `{}` |

## Files

| File | Description |
|------|-------------|
| `src/index.ts` | Main orchestrator — CLI + pipeline |
| `src/search.ts` | Coveo Search API query + pagination |
| `src/transform.ts` | Field transformation logic |
| `src/stream.ts` | Coveo Stream API client (open/chunk/close) |
| `src/types.ts` | TypeScript interfaces and types |
| `.config.json` | Your credentials (not in git) |
| `.config.example.json` | Example config template |
| `export_output/` | Exported JSON batches from search |

## Stream API Details

This tool uses the **Coveo Stream API** (not Push API) via direct HTTP calls:

1. **Open stream** → `POST /push/v1/organizations/{org}/sources/{sourceId}/stream/open` → returns `{ streamId }`
2. **Push chunks** → `PUT /push/v1/organizations/{org}/sources/{sourceId}/stream/{streamId}/chunk` with `{ addOrUpdate: [...], delete: [] }`
3. **Close stream** → `POST /push/v1/organizations/{org}/sources/{sourceId}/stream/{streamId}/close`

On close, **any documents NOT included in the stream are removed** from the source. This is a full rebuild — the stream replaces the entire source content.

### Document format

Each document is a flat JSON object with `documentId` at the top level:

```json
{
  "documentId": "product://36873",
  "title": "SPC SPAGASAURUS 420GM",
  "clickableuri": "https://example.com/product/36873",
  "objecttype": "product",
  "ec_name": "SPC SPAGASAURUS 420GM",
  "ec_price": 8.76,
  "ec_brand": "SPC",
  "ec_category": "HOT & COLD MEALS"
}
```

### Key differences from Push API

| Aspect | Push API (`pbs_source_indexer`) | Stream API (this tool) |
|--------|-------------------------------|------------------------|
| **Source type** | Push source | Catalog source |
| **Flow** | `REBUILD` → batch upload via file containers → `IDLE` | Open stream → chunks → close |
| **Status management** | Manual (`setSourceStatus`) | Automatic (handled by stream lifecycle) |
| **Document format** | `DocumentBuilder` objects | Flat JSON |
| **Dependencies** | `@coveo/push-api-client` npm package | Zero deps (native `fetch`) |
| **Cleanup** | Manual delete of old docs | Automatic — close removes docs not in stream |

## Search API Pagination

- The Coveo Search API v2 allows max 1000 results per request
- `firstResult` + `numberOfResults` cannot exceed 5000
- For indexes with >5000 matching documents, the tool uses **date-based windowing** to paginate beyond the 5000 limit

## Requirements

- **Node.js 18+** (for native `fetch` support)
- **TypeScript** (type-checking via `tsc`, execution via `tsx`)
