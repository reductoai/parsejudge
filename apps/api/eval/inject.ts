// Planted errors. Each injection edits one golden page's spec in one known way and says what the judge should
// report for it, in the categories and severities the judge prompt defines.
import type { ErrorCategory } from "@parsejudge/core";
import { type Block, type GoldenPage, toMarkdown } from "./pages.ts";

export interface Expected {
  /** Categories that count as the right call. The prompt's taxonomy can fairly file some errors under more than one. */
  readonly categories: ReadonlyArray<ErrorCategory>;
  readonly severity: "high" | "low";
}

export type InjectionKind =
  | "changed-digit"
  | "dropped-row"
  | "swapped-columns"
  | "flipped-checkbox"
  | "merged-columns"
  | "dropped-paragraph"
  | "repetition-loop"
  | "invented-sentence"
  | "lowercased-heading";

/** One copy of a page: the untouched control, or one planted error. */
export interface Variant {
  /** `<page id>/<kind>`, or `<page id>/control`. */
  readonly id: string;
  readonly pageId: string;
  readonly kind: InjectionKind | "control";
  /** What was changed, for the report. */
  readonly description: string;
  readonly markdown: string;
  /** Null for the control, which should get no errors. */
  readonly expected: Expected | null;
}

interface Planted {
  readonly blocks: ReadonlyArray<Block>;
  readonly description: string;
  readonly expected: Expected;
}

/** Replaces the first block that `edit` accepts (returns non-null for). */
const editFirst = (
  blocks: ReadonlyArray<Block>,
  edit: (block: Block) => { readonly block: Block | null; readonly description: string } | null,
) => {
  for (const [index, block] of blocks.entries()) {
    const result = edit(block);
    if (result === null) continue;
    const next = result.block === null ? blocks.filter((_, i) => i !== index) : blocks.with(index, result.block);
    return { blocks: next, description: result.description };
  }
  return null;
};

/** The last digit of `text` changed by 5 (mod 10): close enough to look plausible, never the same. */
const changeLastDigit = (text: string) => {
  const at = text.search(/\d(?=\D*$)/);
  if (at === -1) return null;
  const digit = (Number(text[at]) + 5) % 10;
  return `${text.slice(0, at)}${digit}${text.slice(at + 1)}`;
};

const INVENTED = "A second inspection is scheduled for June 3, 2026, at a cost of $4,200.";

const injections: Record<InjectionKind, (page: GoldenPage) => Planted | null> = {
  "changed-digit": (page) => {
    // A wrong number in a table cell, else in a form value, else in prose.
    const table = editFirst(page.blocks, (block) => {
      if (block.kind !== "table") return null;
      const [first, ...rest] = block.rows;
      const cell = first?.[1];
      const changed = cell === undefined ? null : changeLastDigit(cell);
      if (first === undefined || cell === undefined || changed === null) return null;
      return {
        block: { ...block, rows: [first.with(1, changed), ...rest] },
        description: `Table cell "${cell}" written as "${changed}"`,
      };
    });
    if (table !== null) return { ...table, expected: { categories: ["table_content"], severity: "high" } };
    const text = editFirst(page.blocks, (block) => {
      if (block.kind === "form") {
        const index = block.fields.findIndex((field) => /\d/.test(field.value));
        const field = block.fields[index];
        const changed = field === undefined ? null : changeLastDigit(field.value);
        if (field === undefined || changed === null) return null;
        return {
          block: { ...block, fields: block.fields.with(index, { ...field, value: changed }) },
          description: `"${field.label}" value "${field.value}" written as "${changed}"`,
        };
      }
      if (block.kind === "paragraph") {
        const number = block.text.match(/\d{3,}/)?.[0];
        const changed = number === undefined ? null : changeLastDigit(number);
        if (number === undefined || changed === null) return null;
        return {
          block: { ...block, text: block.text.replace(number, changed) },
          description: `"${number}" written as "${changed}"`,
        };
      }
      if (block.kind === "columns") {
        const index = block.left.findIndex((lines) => lines.some((line) => /\d{3,}/.test(line)));
        const lines = block.left[index];
        const number = lines?.join(" ").match(/\d{3,}/)?.[0];
        const changed = number === undefined ? null : changeLastDigit(number);
        if (lines === undefined || number === undefined || changed === null) return null;
        return {
          block: {
            ...block,
            left: block.left.with(
              index,
              lines.map((line) => line.replace(number, changed)),
            ),
          },
          description: `"${number}" written as "${changed}"`,
        };
      }
      return null;
    });
    return text === null ? null : { ...text, expected: { categories: ["text_corruption"], severity: "high" } };
  },

  "dropped-row": (page) => {
    const result = editFirst(page.blocks, (block) => {
      const row = block.kind === "table" ? block.rows[1] : undefined;
      if (block.kind !== "table" || row === undefined) return null;
      return { block: { ...block, rows: block.rows.filter((_, i) => i !== 1) }, description: `Table row "${row[0]}" left out` };
    });
    return result === null
      ? null
      : { ...result, expected: { categories: ["table_structure", "table_content", "content_omission"], severity: "high" } };
  },

  "swapped-columns": (page) => {
    // The values of two columns trade places under unchanged headers.
    const result = editFirst(page.blocks, (block) => {
      if (block.kind !== "table" || block.header.length < 3) return null;
      const swap = (cells: ReadonlyArray<string>) =>
        cells.map((cell, i) => (i === 1 ? cells[2] : i === 2 ? cells[1] : cell) ?? cell);
      return {
        block: { ...block, rows: block.rows.map(swap) },
        description: `Values of "${block.header[1]}" and "${block.header[2]}" swapped under the same headers`,
      };
    });
    return result === null
      ? null
      : { ...result, expected: { categories: ["table_structure", "table_content"], severity: "high" } };
  },

  "flipped-checkbox": (page) => {
    const result = editFirst(page.blocks, (block) => {
      const check = block.kind === "form" ? block.checks[0] : undefined;
      if (block.kind !== "form" || check === undefined) return null;
      const flipped = { ...check, options: check.options.map((option) => ({ ...option, checked: !option.checked })) };
      const was = check.options.find((option) => option.checked)?.label ?? "nothing";
      const now = flipped.options.find((option) => option.checked)?.label ?? "nothing";
      return {
        block: { ...block, checks: block.checks.with(0, flipped) },
        description: `"${check.label}" marked ${now} instead of ${was}`,
      };
    });
    return result === null ? null : { ...result, expected: { categories: ["checkbox_state_error"], severity: "high" } };
  },

  "merged-columns": (page) => {
    // The classic column error: each line of the left column followed by the line beside it on the right.
    const result = editFirst(page.blocks, (block) => {
      if (block.kind !== "columns") return null;
      const left = block.left.flat();
      const right = block.right.flat();
      const merged = Array.from({ length: Math.max(left.length, right.length) }, (_, i) =>
        [left[i], right[i]].filter((line) => line !== undefined).join(" "),
      );
      return {
        block: { kind: "paragraph", text: merged.join(" ") },
        description: "The two columns read across, line by line, as one text",
      };
    });
    return result === null ? null : { ...result, expected: { categories: ["reading_order"], severity: "high" } };
  },

  "dropped-paragraph": (page) => {
    // The last paragraph of the page (or of its right column) left out.
    const reversed = [...page.blocks].reverse();
    const result = editFirst(reversed, (block) => {
      if (block.kind === "paragraph") return { block: null, description: `Paragraph "${block.text.slice(0, 40)}..." left out` };
      const last = block.kind === "columns" ? block.right.at(-1) : undefined;
      if (block.kind !== "columns" || last === undefined) return null;
      return {
        block: { ...block, right: block.right.slice(0, -1) },
        description: `Paragraph "${last.join(" ").slice(0, 40)}..." left out`,
      };
    });
    return result === null
      ? null
      : {
          blocks: [...result.blocks].reverse(),
          description: result.description,
          expected: { categories: ["content_omission"], severity: "high" },
        };
  },

  "repetition-loop": (page) => {
    // The last sentence of the first paragraph repeated eight more times, as a model stuck in a loop writes it.
    const repeat = (text: string) => {
      const sentence = text.match(/[^.!?]+[.!?]$/)?.[0]?.trim() ?? text;
      return { text: `${text}${` ${sentence}`.repeat(8)}`, sentence };
    };
    const result = editFirst(page.blocks, (block) => {
      if (block.kind === "paragraph") {
        const { text, sentence } = repeat(block.text);
        return { block: { ...block, text }, description: `"${sentence.slice(0, 40)}..." repeated 8 more times` };
      }
      const first = block.kind === "columns" ? block.left[0] : undefined;
      if (block.kind !== "columns" || first === undefined) return null;
      const { text, sentence } = repeat(first.join(" "));
      return {
        block: { ...block, left: block.left.with(0, [text]) },
        description: `"${sentence.slice(0, 40)}..." repeated 8 more times`,
      };
    });
    return result === null ? null : { ...result, expected: { categories: ["generation_repetition_loop"], severity: "high" } };
  },

  "invented-sentence": (page) => {
    const result = editFirst(page.blocks, (block) => {
      if (block.kind === "paragraph")
        return { block: { ...block, text: `${block.text} ${INVENTED}` }, description: `Added "${INVENTED}"` };
      const first = block.kind === "columns" ? block.left[0] : undefined;
      if (block.kind !== "columns" || first === undefined) return null;
      return { block: { ...block, left: block.left.with(0, [...first, INVENTED]) }, description: `Added "${INVENTED}"` };
    });
    return result === null ? null : { ...result, expected: { categories: ["content_hallucination"], severity: "high" } };
  },

  "lowercased-heading": (page) => {
    const result = editFirst(page.blocks, (block) => {
      if (block.kind !== "heading" || block.text === block.text.toLowerCase()) return null;
      return {
        block: { ...block, text: block.text.toLowerCase() },
        description: `Heading "${block.text}" written in lowercase`,
      };
    });
    return result === null ? null : { ...result, expected: { categories: ["text_corruption"], severity: "low" } };
  },
};

export const INJECTION_KINDS = Object.keys(injections) as ReadonlyArray<InjectionKind>;

/** The page's untouched control and one variant per injection that applies to it. */
export const variantsOf = (page: GoldenPage): ReadonlyArray<Variant> => [
  {
    id: `${page.id}/control`,
    pageId: page.id,
    kind: "control",
    description: "Unchanged",
    markdown: toMarkdown(page.blocks),
    expected: null,
  },
  ...INJECTION_KINDS.flatMap((kind): ReadonlyArray<Variant> => {
    const planted = injections[kind](page);
    if (planted === null) return [];
    return [
      {
        id: `${page.id}/${kind}`,
        pageId: page.id,
        kind,
        description: planted.description,
        markdown: toMarkdown(planted.blocks),
        expected: planted.expected,
      },
    ];
  }),
];
