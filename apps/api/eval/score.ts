// Scores the judge's verdicts on the golden set against the planted errors.
import type { JudgedError, PresetVerdict } from "@parsejudge/core";
import type { InjectionKind, Variant } from "./inject.ts";

/** What the judge said about one copy of a page. */
export interface Judged {
  readonly variant: Variant;
  /** Null when the judge failed on the page; `failure` says why. */
  readonly verdict: PresetVerdict | null;
  readonly failure?: string;
}

export interface Outcome {
  readonly id: string;
  readonly pageId: string;
  readonly kind: InjectionKind | "control";
  readonly description: string;
  readonly score: number | null;
  /** The judge reported at least one error on this copy. */
  readonly flagged: boolean;
  /** A reported error has one of the planted error's accepted categories. */
  readonly rightCategory: boolean;
  /** One of those also has the planted error's severity. */
  readonly rightSeverity: boolean;
  /** Reported errors in other categories. On a control, every reported error. */
  readonly otherErrors: ReadonlyArray<JudgedError>;
  readonly errors: ReadonlyArray<JudgedError>;
  readonly failure?: string;
}

export interface KindSummary {
  readonly planted: number;
  readonly flagged: number;
  readonly rightCategory: number;
  readonly rightSeverity: number;
}

export interface Report {
  readonly outcomes: ReadonlyArray<Outcome>;
  readonly byKind: Readonly<Partial<Record<InjectionKind, KindSummary>>>;
  readonly total: KindSummary;
  readonly controls: {
    readonly judged: number;
    readonly withErrors: number;
    readonly errors: number;
    readonly meanScore: number | null;
  };
  /** Mean of (control score - copy score) over high-severity copies judged together with their control. */
  readonly highSeverityScoreGap: number | null;
  readonly failed: ReadonlyArray<string>;
}

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

export const outcomeOf = ({ variant, verdict, failure }: Judged): Outcome => {
  const errors = verdict?.errors ?? [];
  const expected = variant.expected;
  const matching = expected === null ? [] : errors.filter((error) => expected.categories.includes(error.category));
  return {
    id: variant.id,
    pageId: variant.pageId,
    kind: variant.kind,
    description: variant.description,
    score: verdict?.score ?? null,
    flagged: errors.length > 0,
    rightCategory: matching.length > 0,
    rightSeverity: expected !== null && matching.some((error) => error.severity === expected.severity),
    otherErrors: expected === null ? errors : errors.filter((error) => !expected.categories.includes(error.category)),
    errors,
    ...(failure === undefined ? {} : { failure }),
  };
};

const summarize = (outcomes: ReadonlyArray<Outcome>): KindSummary => ({
  planted: outcomes.length,
  flagged: outcomes.filter((o) => o.flagged).length,
  rightCategory: outcomes.filter((o) => o.rightCategory).length,
  rightSeverity: outcomes.filter((o) => o.rightSeverity).length,
});

export const scoreGoldenSet = (judged: ReadonlyArray<Judged>): Report => {
  const outcomes = judged.map(outcomeOf);
  const judgedOutcomes = outcomes.filter((o) => o.failure === undefined);
  const planted = judgedOutcomes.filter((o) => o.kind !== "control");
  const controls = judgedOutcomes.filter((o) => o.kind === "control");
  const byKind: Partial<Record<InjectionKind, KindSummary>> = {};
  for (const kind of new Set(planted.map((o) => o.kind))) {
    if (kind !== "control") byKind[kind] = summarize(planted.filter((o) => o.kind === kind));
  }
  const controlScore = new Map(controls.map((o) => [o.pageId, o.score]));
  const gaps = judged.flatMap(({ variant }, i) => {
    const outcome = outcomes[i];
    const base = controlScore.get(variant.pageId);
    if (variant.expected?.severity !== "high" || outcome?.score == null || base == null) return [];
    return [base - outcome.score];
  });
  return {
    outcomes,
    byKind,
    total: summarize(planted),
    controls: {
      judged: controls.length,
      withErrors: controls.filter((o) => o.flagged).length,
      errors: controls.reduce((sum, o) => sum + o.errors.length, 0),
      meanScore: mean(controls.flatMap((o) => (o.score === null ? [] : [o.score]))),
    },
    highSeverityScoreGap: mean(gaps),
    failed: [...new Set(outcomes.filter((o) => o.failure !== undefined).map((o) => o.pageId))],
  };
};

const percent = (part: number, whole: number) => (whole === 0 ? "-" : `${part}/${whole} (${Math.round((100 * part) / whole)}%)`);

const errorLabel = (error: JudgedError) => `${error.category}/${error.severity}`;

/** The report as Markdown: a table per planted error, the controls, and what the judge said where it missed. */
export const reportMarkdown = (report: Report, heading: string): string => {
  const row = (name: string, s: KindSummary) =>
    `| ${name} | ${s.planted} | ${percent(s.flagged, s.planted)} | ${percent(s.rightCategory, s.planted)} | ${percent(s.rightSeverity, s.planted)} |`;
  const kinds = Object.entries(report.byKind).flatMap(([kind, s]) => (s === undefined ? [] : [row(kind, s)]));
  const misses = report.outcomes.filter(
    (o) => o.failure === undefined && o.kind !== "control" && !(o.rightCategory && o.rightSeverity),
  );
  const falseAlarms = report.outcomes.filter((o) => o.kind === "control" && o.flagged);
  const lines = [
    `# ${heading}`,
    "",
    "| Planted error | Copies | Flagged | Right category | Right severity |",
    "| --- | --- | --- | --- | --- |",
    ...kinds,
    row("**All**", report.total),
    "",
    `Controls: ${report.controls.judged} judged, ${report.controls.withErrors} with errors reported (${report.controls.errors} errors), mean score ${report.controls.meanScore?.toFixed(1) ?? "-"}.`,
    report.highSeverityScoreGap === null
      ? ""
      : `High-severity copies scored ${report.highSeverityScoreGap.toFixed(1)} points below their control on average.`,
  ];
  if (misses.length > 0) {
    lines.push("", "## Misses", "");
    for (const o of misses) {
      const said = o.errors.length === 0 ? "no errors" : o.errors.map(errorLabel).join(", ");
      lines.push(`- \`${o.id}\` (${o.description}): judge reported ${said}, score ${o.score ?? "-"}`);
    }
  }
  if (falseAlarms.length > 0) {
    lines.push("", "## Errors reported on controls", "");
    for (const o of falseAlarms) {
      for (const error of o.errors) lines.push(`- \`${o.id}\`: ${errorLabel(error)}: ${error.description}`);
    }
  }
  if (report.failed.length > 0) lines.push("", `Judge failed on: ${report.failed.join(", ")}`);
  return `${lines.join("\n")}\n`;
};
