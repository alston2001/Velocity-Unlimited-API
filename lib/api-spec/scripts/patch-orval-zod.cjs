const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const generatedApi = resolve(process.cwd(), "../api-zod/src/generated/api.ts");
const source = readFileSync(generatedApi, "utf8");
const patched = source
  .replaceAll("zod.int()", "zod.number().int()")
  .replaceAll("zod.uuid()", "zod.string().uuid()");

if (source !== patched) writeFileSync(generatedApi, patched);