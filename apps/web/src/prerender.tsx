/** Build-time entry: renders the static pages to HTML so crawlers and link previews see real content and per-page tags. */
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { Faq } from "./Faq.tsx";
import { FAQS } from "./faq.ts";
import { Landing } from "./Landing.tsx";
import { Legal } from "./Legal.tsx";
import { Methodology } from "./Methodology.tsx";
import { PAGES, type PageKey, SITE_NAME, SITE_URL } from "./seo.ts";

/** ParseBench-2 loads its examples from data.json in the browser, so only its head is prerendered. */
const BODIES: Partial<Record<PageKey, () => ReactNode>> = {
  landing: () => <Landing zdr={false} />,
  methodology: () => <Methodology />,
  faq: () => <Faq />,
  terms: () => <Legal doc="terms" />,
  privacy: () => <Legal doc="privacy" />,
};

const url = (path: string) => (path === "/" ? `${SITE_URL}/` : `${SITE_URL}${path}`);

const structuredData = (key: PageKey): ReadonlyArray<object> => {
  const page = PAGES[key];
  if (key === "landing")
    return [
      { "@context": "https://schema.org", "@type": "WebSite", name: SITE_NAME, url: url("/") },
      {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        name: SITE_NAME,
        url: url("/"),
        description: page.description,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        license: "https://www.apache.org/licenses/LICENSE-2.0",
        sameAs: ["https://github.com/reductoai/parsejudge"],
      },
    ];
  if (key === "methodology")
    return [
      {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: "How Parse Judge scores document parsers",
        description: page.description,
        url: url(page.path),
      },
    ];
  if (key === "faq")
    return [
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: FAQS.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a.join("\n\n") },
        })),
      },
    ];
  return [];
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const replace = (html: string, pattern: RegExp, value: string) => {
  if (!pattern.test(html)) throw new Error(`index.html has no match for ${pattern}`);
  return html.replace(pattern, () => value);
};

const meta = (html: string, attr: "name" | "property", key: string, content: string) =>
  replace(
    html,
    new RegExp(`<meta ${attr}="${key}" content="[^"]*" />`),
    `<meta ${attr}="${key}" content="${escapeHtml(content)}" />`,
  );

/** Components read these browser globals while rendering; give them a page-shaped stand-in. */
const browserGlobals = (path: string) =>
  Object.assign(globalThis, {
    location: new URL(path, SITE_URL),
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  });

const renderPage = (template: string, key: PageKey) => {
  const { path, title, description } = PAGES[key];
  browserGlobals(path);
  const body = BODIES[key]?.() ?? null;
  const json = structuredData(key).map(
    (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`,
  );
  let html = replace(template, /<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);
  html = meta(html, "name", "description", description);
  html = meta(html, "property", "og:title", title);
  html = meta(html, "property", "og:description", description);
  html = meta(html, "property", "og:url", url(path));
  html = meta(html, "name", "twitter:title", title);
  html = meta(html, "name", "twitter:description", description);
  html = replace(html, /<\/head>/, `<link rel="canonical" href="${url(path)}" />\n    ${json.join("\n    ")}\n  </head>`);
  return replace(
    html,
    /<div id="root"><\/div>/,
    `<div id="root" data-path="${path}">${body === null ? "" : renderToString(body)}</div>`,
  );
};

/** One HTML file per page: `/` is index.html, `/faq` is faq.html (Workers assets serve it without a redirect). */
export const render = (template: string) =>
  (Object.keys(PAGES) as Array<PageKey>).map((key) => ({
    file: PAGES[key].path === "/" ? "index.html" : `${PAGES[key].path.slice(1)}.html`,
    html: renderPage(template, key),
  }));

export const sitemap = () =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...Object.values(PAGES).map((p) => `  <url><loc>${url(p.path)}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
