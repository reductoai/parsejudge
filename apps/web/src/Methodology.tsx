import { comparePrompt } from "@parsejudge/core/prompt";
import { type ReactNode, useEffect, useState } from "react";
import { currentUser } from "./api.ts";
import { BlindRequestFigure, SampleSizeFigure, SubsetFigure } from "./figures.tsx";
import { Shell, SiteBar, SiteFoot } from "./Nav.tsx";

const SECTIONS = [
  ["why", "The trouble with vendor benchmarks"],
  ["scored", "What counts as a good parse"],
  ["judge", "Why a model grades"],
  ["run", "How a run works"],
  ["output", "What the judge returns"],
  ["rule", "Why the rule is short"],
  ["report", "What a report shows"],
  ["review", "Checking the judge"],
  ["limits", "Limits"],
  ["data", "Data handling"],
  ["prompt", "Judge prompt"],
] as const;

const Section = ({ id, children }: { readonly id: (typeof SECTIONS)[number][0]; readonly children: ReactNode }) => (
  <section id={id}>
    <h2>{SECTIONS.find(([s]) => s === id)?.[1]}</h2>
    {children}
  </section>
);

const useActive = () => {
  const [active, setActive] = useState<string>(SECTIONS[0][0]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );
    for (const [id] of SECTIONS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);
  return active;
};

export const Methodology = () => {
  const active = useActive();
  useEffect(() => {
    document.title = "Methodology · Parse Judge";
    return () => {
      document.title = "Parse Judge";
    };
  }, []);
  return (
    <Shell topbar={<SiteBar user={currentUser()} active="methodology" />} label="Methodology">
      <div className="page md-page">
        <header className="article-head">
          <h1>How Parse Judge scores document parsers</h1>
          <p>
            Run any set of parsers on your own documents. A vision model grades every output against the page image, without
            knowing which parser wrote it. This page explains how that works, what the scores mean, and where they stop being
            reliable.
          </p>
        </header>
        <div className="article-wrap">
          <nav className="toc wide-only" aria-label="Contents">
            {SECTIONS.map(([id, title]) => (
              <a key={id} href={`#${id}`} aria-current={active === id ? "true" : undefined}>
                {title}
              </a>
            ))}
          </nav>
          <article className="article">
            <Section id="why">
              <p>
                If you shop for a document parser, you will find that almost every vendor has published a benchmark. Each one
                comes with its own documents, its own scoring code and its own rules for what counts as correct. And in almost
                every one, the vendor that wrote it comes first.
              </p>
              <p>
                That is not necessarily dishonest. A vendor builds its benchmark from the documents it cares about and scores what
                its own system does well. But the result tells you how parsers do on that vendor's test, not on your documents.
              </p>
              <p>
                Two things make published numbers harder to trust than they look. The first is how the pages were picked. A team
                can test on 1,000 pages and publish 100. Publishing fewer pages is fine. Picking them after seeing the scores is
                not, and nothing in the published pages shows which one happened.
              </p>
              <SubsetFigure />
              <p>
                The second is how fragile the scores are. Adding white margins or rotating a page slightly changes nothing for a
                person reading it. On public benchmarks, changes like these have caused large score drops, including for the
                benchmark author's own system. Part of the score was about the exact files, not about reading them.
              </p>
              <p>
                Parse Judge does not ship a dataset or a leaderboard. It is a general method: you bring the documents, you pick
                the providers, and every parser is graded by the same blind judge under the same rules. The prompt and the scoring
                code are public, so anyone can check them or run them on their own machines.
              </p>
            </Section>

            <Section id="scored">
              <p>
                A good parse keeps the information on the page: the text, and how it fits together. That includes which table cell
                belongs to which row and column, which label goes with which value, whether a box is checked, and the order the
                page is meant to be read in. Leaving something out is an error. Adding something that is not on the page is an
                error.
              </p>
              <p>
                Format does not matter by itself. A table can be Markdown or HTML. A checked box can be a symbol or a word. Each
                is judged by whether the information is right.
              </p>
            </Section>

            <Section id="judge">
              <p>
                The usual alternative is to have people type out the correct text for every test page and compare each parser
                against it. That is slow and expensive. It also forces you to pick one format for the correct answer, and then you
                are measuring how closely a parser matches that format.
              </p>
              <p>
                Current vision models read page images well enough to check a parse that already exists. The judge looks at the
                image and the outputs and lists where they disagree: missing text, invented values, wrong cells, wrong checkbox
                states, wrong order. Every error it reports can be checked against the image.
              </p>
              <p>
                The judge is still a model and can be wrong, so a person should check its grades for each kind of document (see{" "}
                <a href="#review">Checking the judge</a>). Scores are always reported with the judge model and prompt that
                produced them.
              </p>
            </Section>

            <Section id="run">
              <ol>
                <li>
                  <b>Fix the sample.</b> Pick the pages before any parser runs. Write down how you picked them, and why any page
                  was removed later. Never drop a page because a parser did badly on it.
                </li>
                <li>
                  <b>Render.</b> Word and PowerPoint files are converted to PDF. Each page is rendered once to a PNG at 200 DPI,
                  at most 2,400 px on the long side. Every parser and the judge get that same image.
                </li>
                <li>
                  <b>Parse.</b> Each parser runs once per page with fixed settings, and its raw response is saved. Latency runs
                  from submit to result. Time spent waiting in Parse Judge's own queue is not counted. An error or timeout is a
                  failed parse.
                </li>
                <li>
                  <b>Convert.</b> Each response becomes one Markdown text per page, in reading order. Tables stay in whatever form
                  the parser returned.
                </li>
                <li>
                  <b>Judge.</b> One request per page sends the image and every successful parse under neutral labels. Provider
                  names, file names and settings are not sent.
                </li>
                <li>
                  <b>Check.</b> The response must match a fixed JSON schema, with every label scored once from 1 to 10. Bad
                  responses are retried. A page with no valid response counts as a judge failure.
                </li>
              </ol>
              <BlindRequestFigure />
              <p>
                Every page in a run uses the same judge model, reasoning setting, prompt and schema. All of them are saved with
                the run and listed at the bottom of its report.
              </p>
            </Section>

            <Section id="output">
              <p>
                For each output, the judge first lists errors, then gives a score. Each error has a severity, one of 13
                categories, the type of region, where it is on the page, and one sentence that quotes the page and what the parse
                wrote instead.
              </p>
              <dl className="severity">
                <dt>
                  <span className="tag high">high</span>
                </dt>
                <dd>
                  Information is lost or wrong: a missing section, an invented value, a value under the wrong label, scrambled
                  reading order.
                </dd>
                <dt>
                  <span className="tag low">low</span>
                </dt>
                <dd>Local and superficial, such as punctuation, spacing or an obvious typo. The right reading is still clear.</dd>
              </dl>
              <p>
                Scores run from 1 (empty or mostly wrong) to 10 (no errors found) and must match the error list. One high-severity
                error keeps a score well below 10. Low-severity errors alone can still get a 9 or 10. The judge also tags the page
                itself, for example table, form or handwriting.
              </p>
              <p>
                All outputs for a page are graded in one request, against one image. That way every parser on the page is graded
                by the same reading of it.
              </p>
            </Section>

            <Section id="rule">
              <p>
                The prompt defines a correct parse in a few lines instead of a long format spec. A long spec mixes two things into
                one score: lost information, and how well the output follows the spec. And real documents always contain something
                the spec did not plan for. The short rule asks one question of every page: did the information survive, and can a
                reader get it back?
              </p>
              <p>Five cases have their own rule, because the image alone leaves them unclear:</p>
              <ul>
                <li>Text is copied as printed. Keeping an odd spelling is correct. Fixing it is an error.</li>
                <li>
                  Markers for empty fields, checkboxes, signatures, redactions or unreadable text are fine if they describe what
                  is on the page.
                </li>
                <li>
                  A description of a figure or chart is graded on whether it matches the image. It is not penalized for existing.
                </li>
                <li>Link targets from PDF metadata do not count either way. Visible link text is graded.</li>
                <li>
                  Whitespace, apostrophe style and repeated list markers are ignored if content, order and list structure match.
                </li>
              </ul>
            </Section>

            <Section id="report">
              <p>For each parser, over the pages the judge scored:</p>
              <ul>
                <li>mean and median score;</li>
                <li>wins, ties and losses against each other parser, page by page (a failed parse counts as 1);</li>
                <li>share of pages with at least one high-severity error, with a 95% Wilson interval;</li>
                <li>error counts by category, and failed pages;</li>
                <li>latency (p50 and p95), list price per 1,000 pages, and price against score.</li>
              </ul>
              <p>
                Scores, head-to-head results and error rates are the main comparison. Error counts matter less, because the judge
                may report one problem as one error or as several. Small runs say little: treat a run of fewer than about 100
                pages as a test of the setup, not a result.
              </p>
              <SampleSizeFigure />
              <p>
                Two habits make a result easier to trust. First, report the full sample: pages picked, pages removed and why,
                pages scored, and pages lost to parser or judge failures. Second, when the decision matters, test robustness. Add
                white margins or a small rotation to a fixed set of pages, run it again, and report it separately. A score that
                holds up says something about documents in general. A score that falls says something about those files.
              </p>
            </Section>

            <Section id="review">
              <p>
                Before you use a run to make a decision, compare the judge with a person. Start with the pages where a judge
                mistake is most likely to change the answer:
              </p>
              <ul>
                <li>pages where parser scores differ by 3 or more;</li>
                <li>pages scored 5 or lower;</li>
                <li>pages with a high-severity error;</li>
                <li>a random 10% of pages where every parser scored 8 or higher.</li>
              </ul>
              <p>
                The clean pages matter as much as the flagged ones. Flagged pages show whether the reported errors are real. Clean
                pages show whether errors were missed. Every error quotes both the page and the parse, so a reviewer checks one
                claim instead of re-reading the whole page.
              </p>
              <p>
                Compare by page type, because a judge can be good on prose and weak on dense tables. If the disagreements follow a
                pattern, change the prompt or the judge model and grade every page again. Do not edit scores by hand: a hand-fixed
                result no longer comes from one rule and cannot be rerun.
              </p>
            </Section>

            <Section id="limits">
              <ul>
                <li>
                  Each page is scored on its own. Tables that span pages, reading order across pages and repeated headers are only
                  partly measured.
                </li>
                <li>The judge grades Markdown. Bounding boxes and block metadata are not scored.</li>
                <li>
                  The judge sees an image at most 2,400 px on the long side. Very small print may be hard for it to read, so check
                  dense pages by hand.
                </li>
                <li>
                  A judge can make the same mistakes as a parser built on a similar model, and hiding names does not hide style.
                  For a close call, repeat the run with a second judge model.
                </li>
                <li>
                  Scores are ranks, not measurements. A drop from 9 to 8 is not known to equal a drop from 5 to 4. That is why the
                  median, head-to-head results and error rates are shown next to the mean.
                </li>
                <li>
                  Pages the judge failed on are left out of the scores. If those are mostly hard pages, scores look better than
                  they are. The report shows how many there were.
                </li>
                <li>
                  Two runs are comparable only if the pages, judge model, prompt, schema and parser settings are the same, or the
                  differences are stated.
                </li>
                <li>
                  Latency is wall-clock time during one run, including network and vendor queues. It is not a service level.
                </li>
              </ul>
            </Section>

            <Section id="data">
              <ul>
                <li>
                  Documents go only to the parsers you pick and to the judge model's provider. After judging, a smaller model
                  writes page summaries and finds the quoted errors in each output. It does not change scores.
                </li>
                <li>API keys you add are encrypted, used only for that run, and deleted when it ends.</li>
                <li>
                  Reports can be private or shared by link. You can delete documents, reports or all account data in Settings.
                </li>
                <li>Check each provider's data terms before you upload sensitive documents.</li>
              </ul>
              <p>
                Adding a parser takes a small adapter: accept a page, save the raw response, return Markdown. Providers are
                welcome to correct their own settings and prices. A comparison that uses an old model or a wrong price helps
                nobody.
              </p>
            </Section>

            <Section id="prompt">
              <p>
                This is the exact prompt the judge receives. <code>{"{parse_sections}"}</code> holds one section per label, in
                label order, each with the label as a heading and that parse's Markdown in a code block. <code>{"{labels}"}</code>{" "}
                holds the labels separated by commas, for example <code>parse_a, parse_b</code>.
              </p>
              <details className="prompt">
                <summary>Show the judge prompt</summary>
                <pre>{comparePrompt("{parse_sections}", "{labels}")}</pre>
              </details>
            </Section>
          </article>
        </div>
        <SiteFoot />
      </div>
    </Shell>
  );
};
