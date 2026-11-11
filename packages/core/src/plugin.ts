import type { Preset } from "./presets.ts";
import type { ProviderAdapter } from "./provider.ts";

/** Extra providers and presets compiled into a build. A deployment swaps `#plugins` for its own list at bundle time. */
export interface Plugin {
  readonly providers: ReadonlyArray<ProviderAdapter>;
  readonly presets: ReadonlyArray<Preset>;
}
