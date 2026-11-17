import { PROVIDER_NAMES } from "./names.ts";

export interface Faq {
  readonly id: string;
  readonly q: string;
  /** Plain-text paragraphs, also used for the FAQPage structured data. */
  readonly a: ReadonlyArray<string>;
  readonly link?: { readonly to: string; readonly label: string };
}

const providers = Object.values(PROVIDER_NAMES).sort((a, b) => a.localeCompare(b));
const list = (items: ReadonlyArray<string>) => `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

export const FAQS: ReadonlyArray<Faq> = [
  {
    id: "what",
    q: "What is Parse Judge?",
    a: [
      "Parse Judge is a free, open-source tool for comparing document parsers and OCR APIs on your own documents. You upload documents, pick the parsers, and Parse Judge sends every page to each of them and scores the outputs with a blind LLM judge.",
      "Each run produces a report with scores, high-severity error rates, page-by-page head-to-head results, list price per 1,000 pages and latency.",
    ],
  },
  {
    id: "scoring",
    q: "How does Parse Judge score a parse?",
    a: [
      "Each page is rendered once to a PNG, and every parser gets that same image. A vision model then sees the page image and all the outputs for that page in one request, lists the errors in each output with a severity and category, and gives each output a score from 1 (empty or mostly wrong) to 10 (no errors found).",
      "A good parse keeps the information on the page: the text, table structure, label and value pairs, checkbox states and reading order. Format does not matter by itself, so a table can be Markdown or HTML.",
    ],
    link: { to: "/methodology", label: "Read the methodology" },
  },
  {
    id: "blind",
    q: "Does the judge know which parser wrote each output?",
    a: [
      "No. Outputs are shuffled and labeled parse_a, parse_b and so on. Provider names, file names and settings are not sent to the judge. The judge prompt and scoring code are public, so anyone can check them.",
    ],
  },
  {
    id: "parsers",
    q: "Which document parsers can I compare?",
    a: [
      `${list(providers)}, each with one or more modes. Some run on the site's own credentials. The others need your own API key, which is encrypted, used only for that run and deleted when it ends.`,
      "Anyone can add a parser with a small adapter in the open-source repository.",
    ],
  },
  {
    id: "files",
    q: "What files can I upload, and how many pages?",
    a: [
      "PDF, DOCX and PPTX files, or a .zip of them, up to 1,000 pages per run. Word and PowerPoint files are converted to PDF first.",
    ],
  },
  {
    id: "cost",
    q: "Is Parse Judge free?",
    a: [
      "Yes. The website is free to use and the code is Apache-2.0. Parsers that run on your own API key are billed to your account with that provider at its usual price.",
    ],
  },
  {
    id: "sample",
    q: "How many pages do I need for a reliable comparison?",
    a: [
      "Treat a run of fewer than about 100 pages as a test of the setup, not a result. Pick the pages before any parser runs, and do not drop pages because a parser did badly on them.",
    ],
  },
  {
    id: "benchmarks",
    q: "How is this different from a published parsing benchmark?",
    a: [
      "Parse Judge does not ship a dataset or a leaderboard. You bring the documents and pick the parsers, and every parser is graded by the same blind judge under the same rules. The result tells you how parsers do on your documents, not on a test set someone else picked.",
    ],
  },
  {
    id: "wrong",
    q: "Can the judge be wrong?",
    a: [
      "Yes. The judge is a model. Every error it reports quotes the page and the output, so a person can check it quickly. Before you rely on a run, review the pages where scores differ the most, low-scoring pages and a sample of high-scoring ones. For a close call, rerun with a second judge model.",
    ],
    link: { to: "/methodology#review", label: "How to check the judge" },
  },
  {
    id: "data",
    q: "What happens to my documents?",
    a: [
      "Documents go only to the parsers you pick and to the judge model's provider. Reports are private unless you share them by link, and you can delete documents, reports or all account data in Settings. In ZDR mode, at parsejudge.com/zdr, documents and pages are deleted 24 hours after the run and the results stay.",
      "Check each parser's own data terms before you upload sensitive documents.",
    ],
    link: { to: "/privacy", label: "Privacy Policy" },
  },
  {
    id: "self-host",
    q: "Can I run Parse Judge myself?",
    a: [
      "Yes. The source code is on GitHub under the Apache-2.0 license. It runs on Cloudflare Workers, and a self-hosted build can add its own parsers without changing the repository.",
    ],
    link: { to: "https://github.com/reductoai/parsejudge", label: "Source on GitHub" },
  },
  {
    id: "agents",
    q: "Can I use Parse Judge from an AI agent?",
    a: [
      "Yes. Parse Judge has an MCP server at https://parsejudge.com/mcp that works with Claude, Cursor and other MCP clients, and an HTTP API described at https://parsejudge.com/openapi.json.",
    ],
  },
  {
    id: "who",
    q: "Who maintains Parse Judge?",
    a: [
      "Parse Judge is maintained by Reducto, which also makes a document parser you can select in the tool. Because of that, the judge never sees provider names, every parser gets the same page image, and the prompt and scoring code are open source so the method can be checked and rerun by anyone.",
    ],
  },
];
