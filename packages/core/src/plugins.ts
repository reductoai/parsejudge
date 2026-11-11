import type { Plugin } from "./plugin.ts";

/** The public build has none. Self-hosted builds alias `#plugins` to their own module with the same export. */
export const plugins: ReadonlyArray<Plugin> = [];
