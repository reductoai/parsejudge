import { currentUser } from "./api.ts";
import { FAQS } from "./faq.ts";
import { Shell, SiteBar, SiteFoot } from "./Nav.tsx";
import { usePage } from "./seo.ts";

export const Faq = () => {
  usePage("faq");
  return (
    <Shell topbar={<SiteBar user={currentUser()} />} label="FAQ">
      <div className="page md-page">
        <header className="article-head">
          <h1>Frequently asked questions</h1>
          <p>How Parse Judge compares document parsers, what it does with your documents, and how to run it yourself.</p>
        </header>
        <article className="article">
          {FAQS.map((f) => (
            <section key={f.id} id={f.id}>
              <h2>{f.q}</h2>
              {f.a.map((p) => (
                <p key={p}>{p}</p>
              ))}
              {f.link && (
                <p>
                  <a href={f.link.to}>{f.link.label}</a>
                </p>
              )}
            </section>
          ))}
        </article>
        <SiteFoot />
      </div>
    </Shell>
  );
};
