import { Marked, type TokenizerAndRendererExtension, type Tokens } from "marked";

/**
 * Math in parser output: `\(..\)`, `$..$` inline and `\[..\]`, `$$..$$` display.
 * Markdown is parsed into `.math` placeholders that keep the raw source as text (so judge quotes still match),
 * and `renderMath` typesets them with KaTeX, loaded only when a page has math.
 */

const BLOCK = [/^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/, /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n+|$)/];
const INLINE: ReadonlyArray<readonly [RegExp, boolean]> = [
  [/^\$\$([\s\S]+?)\$\$/, true],
  [/^\\\[([\s\S]+?)\\\]/, true],
  [/^\\\(([\s\S]+?)\\\)/, false],
  // Pandoc's rule keeps prices as text: no space inside either `$`, and no digit right after the closing one.
  [/^\$(?![\s$])((?:\\[\s\S]|[^\\$\n])+?)(?<!\s)\$(?!\d)/, false],
];
const RAW = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$/g;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"\n]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\n": "&#10;" })[c] ?? c);

const placeholder = (tag: "span" | "div", raw: string, tex: string, display: boolean) =>
  `<${tag} class="math${tag === "div" ? " math-block" : ""}" data-tex="${escapeHtml(tex)}"${display ? " data-display" : ""}>` +
  `<span class="math-src">${escapeHtml(raw)}</span></${tag}>`;

const blockMath: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  start: (src) => src.match(/^ {0,3}(?:\$\$|\\\[)/m)?.index,
  tokenizer: (src) => {
    for (const re of BLOCK) {
      const m = re.exec(src);
      if (m) return { type: "blockMath", raw: m[0], text: m[1] ?? "" };
    }
    return undefined;
  },
  renderer: (token) => placeholder("div", token.raw.trim(), (token as Tokens.Generic).text, true),
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  start: (src) => {
    const at = src.search(/\\[([]|\$/);
    return at === -1 ? undefined : at;
  },
  tokenizer: (src) => {
    for (const [re, display] of INLINE) {
      const m = re.exec(src);
      if (m) return { type: "inlineMath", raw: m[0], text: m[1] ?? "", display };
    }
    return undefined;
  },
  renderer: (token) => placeholder("span", token.raw, (token as Tokens.Generic).text, (token as Tokens.Generic).display),
};

const markdown = new Marked({ extensions: [blockMath, inlineMath] });

export const parseMarkdown = (md: string): string => markdown.parse(md, { async: false });

/** Wraps math left as plain text, e.g. inside raw HTML tables, which Markdown parsing does not reach. */
export const wrapRawMath = (root: HTMLElement) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: Array<Text> = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data.search(RAW) !== -1 && !text.parentElement?.closest("code,pre,.math")) hits.push(text);
  }
  for (const text of hits) {
    const template = document.createElement("template");
    let html = "";
    let last = 0;
    for (const m of text.data.matchAll(RAW)) {
      html += escapeHtml(text.data.slice(last, m.index));
      html += placeholder("span", m[0], m[1] ?? m[2] ?? m[3] ?? "", m[2] === undefined);
      last = m.index + m[0].length;
    }
    template.innerHTML = html + escapeHtml(text.data.slice(last));
    text.replaceWith(template.content);
  }
};

export const renderMath = async (root: HTMLElement) => {
  const pending = [...root.querySelectorAll<HTMLElement>(".math:not(.math-rendered)")];
  if (pending.length === 0) return;
  let katex: typeof import("./katex.ts").default;
  try {
    katex = (await import("./katex.ts")).default;
  } catch {
    return;
  }
  for (const el of pending) {
    if (!el.isConnected || el.classList.contains("math-rendered")) continue;
    const out = document.createElement("span");
    out.className = "math-out";
    try {
      katex.render(el.dataset.tex ?? "", out, {
        displayMode: el.dataset.display !== undefined,
        throwOnError: true,
        strict: false,
      });
    } catch {
      continue;
    }
    el.querySelector(".math-src")?.setAttribute("aria-hidden", "true");
    el.append(out);
    el.classList.add("math-rendered");
  }
};
