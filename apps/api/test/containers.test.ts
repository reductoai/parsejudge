/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: () => undefined }));

const { INSTANCES: CONVERTER_INSTANCES } = await import("../src/converter.ts");
const { INSTANCES: SPLITTER_INSTANCES } = await import("../src/splitter.ts");

/** `max_instances` of each container class in a wrangler config. */
const maxInstances = (file: string) => {
  const text = readFileSync(join(import.meta.dirname, "..", file), "utf8");
  return Object.fromEntries(
    [...text.matchAll(/"class_name":\s*"(\w+)"[^}]*?"max_instances":\s*(\d+)/g)].map(([, name, count]) => [name, Number(count)]),
  );
};

// getRandom spreads requests over INSTANCES Durable Objects, one container each. More than max_instances and some
// requests can't start a container; fewer and some capacity is never used.
describe.each(["wrangler.jsonc", "wrangler.prod.jsonc"])("%s", (file) => {
  it("allows exactly as many containers as the Worker spreads requests over", () => {
    expect(maxInstances(file)).toEqual({ Converter: CONVERTER_INSTANCES, Splitter: SPLITTER_INSTANCES });
  });
});
