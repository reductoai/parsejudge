/// <reference types="node" />
// Golden pages: each one is drawn to a PDF and written as Markdown from the same spec, so the Markdown is exactly
// what a perfect parse of the page says. Error injection (inject.ts) edits the spec, not the Markdown text.
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";

export type Block =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "table"; readonly header: ReadonlyArray<string>; readonly rows: ReadonlyArray<ReadonlyArray<string>> }
  | {
      readonly kind: "form";
      readonly fields: ReadonlyArray<{ readonly label: string; readonly value: string }>;
      readonly checks: ReadonlyArray<{
        readonly label: string;
        readonly options: ReadonlyArray<{ readonly label: string; readonly checked: boolean }>;
      }>;
    }
  /** Two columns of paragraphs, given as the lines they are drawn in, so a column-merging error can be made exactly. */
  | {
      readonly kind: "columns";
      readonly left: ReadonlyArray<ReadonlyArray<string>>;
      readonly right: ReadonlyArray<ReadonlyArray<string>>;
    };

export type PageType = "prose" | "table" | "form" | "two-column";

export interface GoldenPage {
  readonly id: string;
  readonly type: PageType;
  readonly blocks: ReadonlyArray<Block>;
}

export const GOLDEN_PAGES: ReadonlyArray<GoldenPage> = [
  {
    id: "maintenance-notice",
    type: "prose",
    blocks: [
      { kind: "heading", text: "Notice of Scheduled Maintenance" },
      {
        kind: "paragraph",
        text: "The Harborview Water District will replace the main valve on Alder Street between 9:00 AM and 3:00 PM on Tuesday, March 17, 2026. Water service to 214 homes will be shut off during this window.",
      },
      {
        kind: "paragraph",
        text: "Residents should store at least 12 liters of drinking water per person before the work begins. Bottled water will be available at the Alder Street fire station, 4410 Alder Street, from 8:00 AM.",
      },
      {
        kind: "paragraph",
        text: "The district expects the work to cost $86,450, which is covered by the 2025 capital budget. Questions can be sent to service@harborview-water.example or by phone at 555-0142.",
      },
    ],
  },
  {
    id: "regional-sales",
    type: "table",
    blocks: [
      { kind: "heading", text: "Regional Sales, Third Quarter 2026" },
      { kind: "paragraph", text: "Figures are in thousands of US dollars and include returns processed before October 5." },
      {
        kind: "table",
        header: ["Region", "July", "August", "September", "Total"],
        rows: [
          ["North", "1,284", "1,197", "1,402", "3,883"],
          ["South", "962", "1,045", "1,118", "3,125"],
          ["East", "1,530", "1,488", "1,611", "4,629"],
          ["West", "874", "903", "951", "2,728"],
        ],
      },
      { kind: "paragraph", text: "East led the quarter for the third time in a row." },
    ],
  },
  {
    id: "incident-report",
    type: "form",
    blocks: [
      { kind: "heading", text: "Vehicle Incident Report" },
      {
        kind: "form",
        fields: [
          { label: "Name of driver", value: "Dana Whitfield" },
          { label: "Policy number", value: "PX-4471-0938" },
          { label: "Date of incident", value: "02/11/2026" },
          { label: "Location", value: "Route 9 and Mill Road, Cedar Falls" },
        ],
        checks: [
          {
            label: "Police report filed?",
            options: [
              { label: "Yes", checked: true },
              { label: "No", checked: false },
            ],
          },
          {
            label: "Was anyone injured?",
            options: [
              { label: "Yes", checked: false },
              { label: "No", checked: true },
            ],
          },
          {
            label: "Vehicle drivable after incident?",
            options: [
              { label: "Yes", checked: true },
              { label: "No", checked: false },
            ],
          },
        ],
      },
      { kind: "paragraph", text: "I confirm the information above is accurate to the best of my knowledge." },
    ],
  },
  {
    id: "bird-survey",
    type: "two-column",
    blocks: [
      { kind: "heading", text: "Field Notes: Spring Bird Survey" },
      {
        kind: "columns",
        left: [
          [
            "Observers counted 37 species along the",
            "north trail on April 4, up from 29 the",
            "previous spring. The largest group was a",
            "flock of 120 cedar waxwings near the pond.",
          ],
          [
            "Two pairs of ospreys returned to the nest",
            "platform on the east shore and were seen",
            "carrying sticks by mid-morning.",
          ],
        ],
        right: [
          [
            "The south meadow was quieter. Only 11",
            "species were recorded there, and heavy",
            "mowing along the fence line may explain",
            "the drop in sparrow sightings.",
          ],
          [
            "The next survey is set for May 9. Teams",
            "should meet at the visitor center at 6:30",
            "and bring the updated tally sheets.",
          ],
        ],
      },
    ],
  },
];

const tableMarkdown = (header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>) =>
  [header, header.map(() => "---"), ...rows].map((cells) => `| ${cells.join(" | ")} |`).join("\n");

const checkboxMarkdown = (options: ReadonlyArray<{ readonly label: string; readonly checked: boolean }>) =>
  options.map((option) => `[${option.checked ? "x" : " "}] ${option.label}`).join(" ");

export const blockMarkdown = (block: Block): string => {
  switch (block.kind) {
    case "heading":
      return `# ${block.text}`;
    case "paragraph":
      return block.text;
    case "table":
      return tableMarkdown(block.header, block.rows);
    case "form":
      return [
        ...block.fields.map((field) => `${field.label}: ${field.value}`),
        "",
        ...block.checks.map((check) => `${check.label} ${checkboxMarkdown(check.options)}`),
      ].join("\n");
    case "columns":
      // Reading order: all of the left column, then all of the right.
      return [...block.left, ...block.right].map((lines) => lines.join(" ")).join("\n\n");
  }
};

/** Ground-truth Markdown: what a perfect parse of the drawn page says, in reading order. */
export const toMarkdown = (blocks: ReadonlyArray<Block>): string => blocks.map(blockMarkdown).join("\n\n");

const PAGE = { width: 612, height: 792, margin: 60 } as const;
const CONTENT_WIDTH = PAGE.width - 2 * PAGE.margin;
const BLACK = rgb(0, 0, 0);

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
}

/** Fails when drawn text would not fit its box, so a page never silently draws something the Markdown doesn't say. */
const assertFits = (font: PDFFont, text: string, size: number, width: number) => {
  if (font.widthOfTextAtSize(text, size) > width) throw new Error(`Text does not fit in ${width}pt: "${text}"`);
};

const wrap = (font: PDFFont, text: string, size: number, width: number): Array<string> => {
  const lines: Array<string> = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
};

/** Draws a block with its top at `y` and returns the y below it. */
const drawBlock = (page: PDFPage, fonts: Fonts, block: Block, y: number): number => {
  const x = PAGE.margin;
  switch (block.kind) {
    case "heading": {
      assertFits(fonts.bold, block.text, 16, CONTENT_WIDTH);
      page.drawText(block.text, { x, y: y - 16, size: 16, font: fonts.bold, color: BLACK });
      return y - 34;
    }
    case "paragraph": {
      let top = y;
      for (const line of wrap(fonts.regular, block.text, 11, CONTENT_WIDTH)) {
        page.drawText(line, { x, y: top - 11, size: 11, font: fonts.regular, color: BLACK });
        top -= 15;
      }
      return top - 10;
    }
    case "table": {
      const columns = block.header.length;
      const cellWidth = CONTENT_WIDTH / columns;
      const rowHeight = 22;
      let top = y;
      for (const [index, cells] of [block.header, ...block.rows].entries()) {
        const font = index === 0 ? fonts.bold : fonts.regular;
        for (const [column, cell] of cells.entries()) {
          const left = x + column * cellWidth;
          page.drawRectangle({ x: left, y: top - rowHeight, width: cellWidth, height: rowHeight, borderWidth: 0.75 });
          assertFits(font, cell, 10.5, cellWidth - 10);
          page.drawText(cell, { x: left + 5, y: top - 15, size: 10.5, font, color: BLACK });
        }
        top -= rowHeight;
      }
      return top - 16;
    }
    case "form": {
      let top = y;
      for (const field of block.fields) {
        const label = `${field.label}:`;
        page.drawText(label, { x, y: top - 11, size: 11, font: fonts.bold, color: BLACK });
        const valueX = x + fonts.bold.widthOfTextAtSize(label, 11) + 6;
        assertFits(fonts.regular, field.value, 11, PAGE.width - PAGE.margin - valueX);
        page.drawText(field.value, { x: valueX, y: top - 11, size: 11, font: fonts.regular, color: BLACK });
        top -= 20;
      }
      top -= 8;
      for (const check of block.checks) {
        page.drawText(check.label, { x, y: top - 11, size: 11, font: fonts.regular, color: BLACK });
        let optionX = x + fonts.regular.widthOfTextAtSize(check.label, 11) + 14;
        for (const option of check.options) {
          const box = { x: optionX, y: top - 12, size: 11 };
          page.drawRectangle({ x: box.x, y: box.y, width: box.size, height: box.size, borderWidth: 1 });
          if (option.checked) {
            // The X is drawn as lines, not text, as on a scanned or filled-in form.
            page.drawLine({ start: { x: box.x + 2, y: box.y + 2 }, end: { x: box.x + 9, y: box.y + 9 }, thickness: 1.4 });
            page.drawLine({ start: { x: box.x + 2, y: box.y + 9 }, end: { x: box.x + 9, y: box.y + 2 }, thickness: 1.4 });
          }
          page.drawText(option.label, { x: box.x + 16, y: top - 11, size: 11, font: fonts.regular, color: BLACK });
          optionX += 16 + fonts.regular.widthOfTextAtSize(option.label, 11) + 18;
        }
        top -= 22;
      }
      return top - 10;
    }
    case "columns": {
      const gap = 24;
      const columnWidth = (CONTENT_WIDTH - gap) / 2;
      const drawColumn = (paragraphs: ReadonlyArray<ReadonlyArray<string>>, left: number) => {
        let top = y;
        for (const lines of paragraphs) {
          for (const line of lines) {
            assertFits(fonts.regular, line, 10, columnWidth);
            page.drawText(line, { x: left, y: top - 10, size: 10, font: fonts.regular, color: BLACK });
            top -= 14;
          }
          top -= 8;
        }
        return top;
      };
      return Math.min(drawColumn(block.left, x), drawColumn(block.right, x + columnWidth + gap)) - 10;
    }
  }
};

/** Draws the page's blocks to a one-page US Letter PDF. */
export const buildPdf = async (blocks: ReadonlyArray<Block>): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  // Fixed dates so the same page always produces the same bytes.
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  doc.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const page = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;
  for (const block of blocks) y = drawBlock(page, fonts, block, y);
  if (y < PAGE.margin) throw new Error("Page content runs past the bottom margin");
  return doc.save();
};
