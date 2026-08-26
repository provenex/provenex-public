import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import * as checkpoint from "../src/checkpoint.mjs";

// The runtime module is plain ESM and the declarations are hand-authored, so
// nothing compiles one from the other. This pins the two value surfaces to
// each other: every runtime export must be declared, and every declared VALUE
// must exist at runtime. (Type-only exports have no runtime half and are not
// checked here; TypeScript consumers check those against their own usage.)
test("the hand-authored declarations and the runtime module export the same values", async () => {
  const dts = await readFile(new URL("../types/checkpoint.d.ts", import.meta.url), "utf8");

  const declared = new Set(
    [...dts.matchAll(/export declare (?:const|function|class) ([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  );
  const runtime = new Set(Object.keys(checkpoint));

  for (const name of runtime) {
    assert.ok(
      declared.has(name),
      `runtime export ${name} is missing from types/checkpoint.d.ts`,
    );
  }
  for (const name of declared) {
    assert.ok(
      runtime.has(name),
      `types/checkpoint.d.ts declares ${name}, which src/checkpoint.mjs does not export`,
    );
  }
});
