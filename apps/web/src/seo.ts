import { useEffect } from "react";

export const SITE_URL = "https://parsejudge.com";
export const SITE_NAME = "Parse Judge";

/** Title and description for each page that is prerendered and listed in the sitemap. */
export const PAGES = {
  landing: {
    path: "/",
    title: "Parse Judge: compare document parsers and OCR APIs on your own documents",
    description:
      "Compare PDF parsers and OCR APIs on your own documents. Every page goes to each parser as the same image, and a blind LLM judge scores the outputs. Free and open source.",
  },
  methodology: {
    path: "/methodology",
    title: "Methodology: how Parse Judge scores document parsers",
    description:
      "How Parse Judge renders, parses and blind-judges every page, what a report shows, how to check the judge, and where the scores stop being reliable.",
  },
  faq: {
    path: "/faq",
    title: "FAQ: comparing document parsers with a blind judge · Parse Judge",
    description:
      "Answers about Parse Judge: how pages are scored, which parsers you can compare, file types and limits, sample sizes, data handling, self-hosting and MCP access.",
  },
  parsebench2: {
    path: "/parsebench-2",
    title: "ParseBench-2 examples: benchmark scores next to the page · Parse Judge",
    description:
      "Examples where ParseBench-2 scores and a page-level review disagree, with the page image, the parser output and the correct answer side by side.",
  },
  terms: {
    path: "/terms",
    title: "Terms of Service · Parse Judge",
    description: "The terms for using Parse Judge at parsejudge.com.",
  },
  privacy: {
    path: "/privacy",
    title: "Privacy Policy · Parse Judge",
    description: "How Parse Judge collects, uses and deletes personal information and the documents you upload.",
  },
} as const;

export type PageKey = keyof typeof PAGES;

const applyPage = (key: PageKey) => {
  const { path, title, description } = PAGES[key];
  const href = `${SITE_URL}${path}`;
  document.title = title;
  const set = (selector: string, attr: string, value: string) => document.head.querySelector(selector)?.setAttribute(attr, value);
  set('meta[name="description"]', "content", description);
  set('meta[property="og:title"]', "content", title);
  set('meta[property="og:description"]', "content", description);
  set('meta[property="og:url"]', "content", href);
  set('meta[name="twitter:title"]', "content", title);
  set('meta[name="twitter:description"]', "content", description);
  set('link[rel="canonical"]', "href", href);
};

/** Sets the title, description and canonical URL while a page is mounted, and puts the home page's back after. */
export const usePage = (key: PageKey) => {
  useEffect(() => {
    applyPage(key);
    return () => applyPage("landing");
  }, [key]);
};
