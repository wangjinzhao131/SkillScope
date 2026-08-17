import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// Pi loads TypeScript extensions through its own loader. Node's test runner
// needs this tiny test-only hook to both transpile TS and map emitted-style
// `.js` specifiers back to source `.ts` files.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const output = stripTypeScriptTypes(source, {
        mode: "strip",
        sourceUrl: url,
      });
      return { format: "module", source: output, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
