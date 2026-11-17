import { marked } from "marked";
import { currentUser } from "./api.ts";
import privacy from "./legal/privacy.md?raw";
import terms from "./legal/terms.md?raw";
import { Shell, SiteBar, SiteFoot } from "./Nav.tsx";
import { usePage } from "./seo.ts";

const DOCS = {
  terms: { title: "Terms of Service", body: terms },
  privacy: { title: "Privacy Policy", body: privacy },
} as const;

const UPDATED = "November 6, 2026";

export const Legal = ({ doc }: { readonly doc: keyof typeof DOCS }) => {
  const { title, body } = DOCS[doc];
  usePage(doc);
  return (
    <Shell topbar={<SiteBar user={currentUser()} />} label={title}>
      <div className="page md-page legal-page">
        <header className="article-head">
          <h1>{title}</h1>
          <p>Last updated {UPDATED}</p>
        </header>
        <article
          className="article"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: the HTML is built from our own bundled Markdown.
          dangerouslySetInnerHTML={{ __html: marked.parse(body, { async: false }) }}
        />
        <SiteFoot />
      </div>
    </Shell>
  );
};
