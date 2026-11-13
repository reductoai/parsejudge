# Parse Judge: open-source document parser benchmark

Compare PDF parsers and OCR APIs on **your own documents**. Parse Judge renders every page to the same image, sends
it to each provider, and scores the outputs with a blind LLM judge (vision model, provider names hidden). Each run
produces a shareable report covering accuracy, high-severity errors, cost per 1k pages, latency, head-to-head results
and score vs. price.

**[Try it at parsejudge.com](https://parsejudge.com)** · [Methodology](https://parsejudge.com/methodology) ·
[Self-host](#self-host)

![Parse Judge report: mean score, high-severity error rate, cost per 1k pages and latency for each document parser on 150 pages of federal court documents](.github/assets/report.webp)

## Why

Most document parsing benchmarks are published by a vendor, on documents that vendor picked, with that vendor's
scoring code. Parse Judge runs any set of parsers on the documents you care about and shows the judge's reasoning
for every page. The prompt and scoring code are in this repo.

- **Blind judging.** Outputs are shuffled and labeled `parse_a`, `parse_b`, ... The judge sees the page image and
  every parse, never the provider name.
- **Same input for everyone.** Each page goes to every provider as the same rendered PNG.
- **Per-page evidence.** Every score comes with a list of errors and their severity, located in the output.
- **Cost and latency.** List price per 1k pages and p50/p95 latency next to accuracy.
- **PDF, DOCX and PPTX.** Up to 1,000 pages per run.
- **Agent-friendly.** Query runs from Claude, Cursor or any MCP client: `claude mcp add --transport http parsejudge https://parsejudge.com/mcp`.

![Side-by-side comparison of a page image with Reducto and Azure Document Intelligence markdown outputs, judge scores and flagged errors](.github/assets/compare.webp)

## Supported document parsers

| Provider                    | Presets                               | Hosted run         |
| --------------------------- | ------------------------------------- | ------------------ |
| Reducto                     | r-1, r-1 mini                         | yes                |
| Azure Document Intelligence | layout, high-res                      | yes                |
| AWS Textract                | layout, tables                        | yes                |
| Google Document AI          | Layout Parser                         | yes, opt-in        |
| Mistral OCR                 | OCR 4.1                               | bring your own key |
| Extend                      | performance, agentic; light           | bring your own key |
| LlamaParse                  | agentic-plus, agentic, cost-effective | bring your own key |
| Datalab (Marker)            | accurate, balanced, fast              | bring your own key |
| Pulse                       | Ultra 2, refine                       | bring your own key |
| Cohere                      | Parse v5                              | bring your own key |
| Nutrient                    | agentic, understand, structure        | bring your own key |

`GET /v1/presets` returns the full list with list prices. To add a provider, add an adapter in
`packages/core/src/providers` and a preset in `packages/core/src/presets.ts`. A self-hosted build can add
providers without editing this repo: bundle the Worker with `#plugins` aliased to a module that exports
`plugins: ReadonlyArray<Plugin>` (see `packages/core/src/plugins.ts`).

![Parse Judge upload page: drop PDF, DOCX or PPTX files and pick which document parsers to compare](.github/assets/landing.webp)

## Layout

- `packages/core`: provider adapters, judge, scoring. Effect only, no Cloudflare imports.
- `apps/api`: Cloudflare Worker. HTTP API, MCP server, Workflows, D1, R2, one Durable Object per run.
- `apps/web`: React frontend.
- `containers/`: DOCX/PPTX to PDF conversion and PDF splitting.

## Run locally

Requirements: Node 24.22+ (`.nvmrc`; 22.23+ also works, earlier versions fail the API tests), pnpm 10,
Docker (Wrangler builds the conversion containers) and
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

```sh
pnpm install
pnpm --filter ./apps/web build    # the Worker serves the frontend from apps/web/dist
cd apps/api
cp .dev.vars.example .dev.vars        # fill in the keys you have
npx wrangler d1 migrations apply parsejudge --local
cloudflared tunnel --url http://localhost:8787   # providers fetch pages from a public URL
npx wrangler dev --var PUBLIC_URL:<tunnel url>
```

Progress streams on `ws://localhost:8787/v1/runs/<runId>/events`. Results: `GET /v1/runs/<runId>`.
The OpenAPI document is at `/openapi.json`.

## Self-host

Deploy `apps/api` to your own Cloudflare account: create the D1 database and R2 bucket named in
`wrangler.jsonc`, set the secrets from `.dev.vars.example` with `wrangler secret put`, apply migrations with
`--remote`, then `wrangler deploy`. DOCX and PPTX conversion runs in the LibreOffice container in
`containers/libreoffice`; Wrangler builds it with Docker on deploy and in `wrangler dev`.

## Usage and cost

Every provider parse, judge call and small-model call (page notes, error locations, run titles) is logged to
Workers Logs as an `{"event":"usage",...}` line and written to the Analytics Engine dataset `parsejudge_usage`.
Model cost is computed from the token counts at OpenAI's list prices (`PRICES` in `apps/api/src/usage.ts`); provider cost is the provider's reported
cost or the list price. Columns are listed in `apps/api/src/usage.ts`. Query it with the
[SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/), for example cost per run and kind:

```sql
SELECT blob3 AS run, blob1 AS kind, blob2 AS name, SUM(_sample_interval) AS calls,
       SUM(_sample_interval * double1) AS cost_usd
FROM parsejudge_usage
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY run, kind, name ORDER BY cost_usd DESC
```

Traces of each request and workflow step are in Workers Observability.

## Checks

```sh
pnpm check && pnpm test && pnpm lint
```

## License

[Apache-2.0](LICENSE). Copyright Reducto, Inc. The Parse Judge and Reducto names are not licensed for use by forks.
