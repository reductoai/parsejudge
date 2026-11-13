// Entry point for `pnpm judge-eval`. Options are described at the top of run.ts.
import { Effect } from "effect";
import { main } from "./run.ts";

await Effect.runPromise(main);
