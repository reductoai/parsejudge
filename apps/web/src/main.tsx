import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import "./styles.css";
import { Account } from "./Account.tsx";
import { loadUser } from "./api.ts";
import { Landing } from "./Landing.tsx";
import { Legal } from "./Legal.tsx";
import { Methodology } from "./Methodology.tsx";
import { PageCompare } from "./PageCompare.tsx";
import { ParseBench2 } from "./ParseBench2.tsx";
import { RunPage } from "./RunPage.tsx";
import { Runs } from "./Runs.tsx";
import { useRoute } from "./router.ts";
import { SignInLink } from "./SignIn.tsx";
import { SignInPage } from "./SignInPage.tsx";

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
if (root)
  loadUser().finally(() =>
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
