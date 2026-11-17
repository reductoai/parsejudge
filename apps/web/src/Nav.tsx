import type { ReactNode, RefObject } from "react";
import "./ax/pjx.css";
import "./ax/shell.css";
import { navigate } from "./router.ts";

/** In-app link: a real href for new tabs, client-side navigation for plain clicks. */
export const Go = ({
  to,
  className,
  children,
  ...rest
}: { readonly to: string; readonly className?: string | undefined; readonly children: ReactNode } & Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
>) => (
  <a
    {...rest}
    className={className}
    href={to}
    onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    }}
  >
    {children}
  </a>
);

/** The design's page frame: one topbar over a scrolling content pane. */
export const Shell = ({
  topbar,
  children,
  label,
  pane,
}: {
  readonly topbar: ReactNode;
  readonly children: ReactNode;
  readonly label?: string;
  readonly pane?: RefObject<HTMLDivElement | null>;
}) => (
  <div className="pjx" data-topbar-rule="always">
    <div className="app">
      <div className="main-col">
        {topbar}
        <div className="content-pane" ref={pane} data-screen-label={label}>
          {children}
        </div>
      </div>
    </div>
  </div>
);

export const SiteBar = ({ user, active }: { readonly user?: string | null; readonly active?: "runs" | "methodology" }) => (
  <div className="topbar site-bar">
    <div className="site-bar-in">
      <Go className="site-brand" to="/">
        Parse Judge
      </Go>
      <nav className="site-nav">
        {user && (
          <Go to="/runs" className={active === "runs" ? "is-strong" : undefined}>
            Runs
          </Go>
        )}
        <Go to="/methodology" className={active === "methodology" ? "is-strong" : undefined}>
          Methodology
        </Go>
        <a className="site-src" href="https://github.com/reductoai/parsejudge" target="_blank" rel="noopener">
          Source
        </a>
        {user ? (
          <Go className="is-strong site-user" to="/account">
            {user}
          </Go>
        ) : (
          <Go className="is-strong" to={`/signin?next=${encodeURIComponent(location.pathname)}`}>
            Sign in
          </Go>
        )}
      </nav>
    </div>
  </div>
);

export const SiteFoot = () => (
  <footer className="site-foot">
    <Go to="/faq">FAQ</Go>
    <Go to="/terms">Terms</Go>
    <Go to="/privacy">Privacy</Go>
  </footer>
);

/** The site bar on pages that are not yet in the design's frame. */
export const Nav = (props: { readonly user?: string | null; readonly active?: "runs" | "methodology" }) => (
  <div className="pjx pjx-nav" data-topbar-rule="always">
    <div className="app">
      <div className="main-col">
        <SiteBar {...props} />
      </div>
    </div>
  </div>
);
