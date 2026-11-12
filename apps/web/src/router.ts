import { useEffect, useState } from "react";

export type Route =
  | { readonly name: "landing"; readonly zdr: boolean }
  | { readonly name: "account" }
  | { readonly name: "runs" }
  | { readonly name: "methodology" }
  | { readonly name: "parsebench2" }
  | { readonly name: "terms" }
  | { readonly name: "privacy" }
  | { readonly name: "signin"; readonly next: string }
  | { readonly name: "auth"; readonly token: string }
  | { readonly name: "run"; readonly shareId: string }
  | { readonly name: "page"; readonly shareId: string; readonly pageId: string; readonly view: "side" | "all" };

export const parse = (path: string, search: string): Route => {
  const page = /^\/r\/([^/]+)\/p\/([^/]+)$/.exec(path);
  if (page?.[1] && page[2])
    return {
      name: "page",
      shareId: page[1],
      pageId: page[2],
      view: new URLSearchParams(search).get("view") === "all" ? "all" : "side",
    };
  if (path === "/account") return { name: "account" };
  if (path === "/runs") return { name: "runs" };
  if (path === "/methodology") return { name: "methodology" };
  if (path === "/parsebench-2") return { name: "parsebench2" };
  if (path === "/terms") return { name: "terms" };
  if (path === "/privacy") return { name: "privacy" };
  if (path === "/signin") return { name: "signin", next: new URLSearchParams(search).get("next") ?? "/" };
  if (path === "/auth") return { name: "auth", token: new URLSearchParams(search).get("token") ?? "" };
  const run = /^\/r\/([^/]+)$/.exec(path);
  if (run?.[1]) return { name: "run", shareId: run[1] };
  return { name: "landing", zdr: path === "/zdr" };
};

export const navigate = (to: string) => {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
};

export const useRoute = () => {
  const [route, setRoute] = useState(() => parse(location.pathname, location.search));
  useEffect(() => {
    const update = () => setRoute(parse(location.pathname, location.search));
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return route;
};
