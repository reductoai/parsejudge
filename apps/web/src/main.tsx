import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import "./styles.css";
import { loadUser } from "./api.ts";
import { Landing } from "./Landing.tsx";
import { parse, type Route, useRoute } from "./router.ts";
import { SignInLink } from "./SignIn.tsx";
import { SignInPage } from "./SignInPage.tsx";

const chunks = {
  account: () => import("./Account.tsx").then((m) => ({ default: m.Account })),
  runs: () => import("./Runs.tsx").then((m) => ({ default: m.Runs })),
  methodology: () => import("./Methodology.tsx").then((m) => ({ default: m.Methodology })),
  parsebench2: () => import("./ParseBench2.tsx").then((m) => ({ default: m.ParseBench2 })),
  legal: () => import("./Legal.tsx").then((m) => ({ default: m.Legal })),
  run: () => import("./RunPage.tsx").then((m) => ({ default: m.RunPage })),
  page: () => import("./PageCompare.tsx").then((m) => ({ default: m.PageCompare })),
};
const chunkOf = (route: Route): keyof typeof chunks | null =>
  route.name === "terms" || route.name === "privacy"
    ? "legal"
    : route.name in chunks
      ? (route.name as keyof typeof chunks)
      : null;
const Account = lazy(chunks.account);
const Runs = lazy(chunks.runs);
const Methodology = lazy(chunks.methodology);
const ParseBench2 = lazy(chunks.parsebench2);
const Legal = lazy(chunks.legal);
const RunPage = lazy(chunks.run);
const PageCompare = lazy(chunks.page);

const App = () => {
  const route = useRoute();
  if (route.name === "account") return <Account />;
  if (route.name === "runs") return <Runs />;
  if (route.name === "methodology") return <Methodology />;
  if (route.name === "parsebench2") return <ParseBench2 />;
  if (route.name === "terms" || route.name === "privacy") return <Legal doc={route.name} />;
  if (route.name === "signin") return <SignInPage next={route.next} />;
  if (route.name === "auth") return <SignInLink token={route.token} />;
  if (route.name === "run") return <RunPage shareId={route.shareId} />;
  if (route.name === "page") return <PageCompare shareId={route.shareId} pageId={route.pageId} view={route.view} />;
  return <Landing zdr={route.name === "landing" && route.zdr} />;
};

const root = document.getElementById("root");
const first = chunkOf(parse(location.pathname, location.search));
if (root)
  Promise.allSettled([loadUser(), first && chunks[first]()]).finally(() =>
    createRoot(root).render(
      <StrictMode>
        <Suspense>
          <App />
        </Suspense>
      </StrictMode>,
    ),
  );
