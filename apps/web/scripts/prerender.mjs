// Writes the prerendered pages and sitemap into dist/, from the SSR bundle of src/prerender.tsx.
import { readFile, rm, writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
const ssr = new URL("../dist-ssr/", import.meta.url);
const { render, sitemap } = await import(new URL("prerender.js", ssr).href);
const template = await readFile(new URL("index.html", dist), "utf8");
for (const { file, html } of render(template)) await writeFile(new URL(file, dist), html);
await writeFile(new URL("sitemap.xml", dist), sitemap());
await rm(ssr, { recursive: true, force: true });
