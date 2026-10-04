// Release qualification reads the tested platform's actual locale set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const path = process.argv[2];
assert(path, "pass the tested OpenAgent src/lib/platformLocales.json path");
const platform = Object.keys(JSON.parse(readFileSync(path, "utf8")));
assert(platform.length > 0, "platform locale set is empty");
const i18n = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
).extensions.openagent.i18n;
for (const locale of platform)
  assert(
    i18n.supported_locales.includes(locale),
    `missing platform locale: ${locale}`,
  );
console.log(`Qualified platform locale coverage: ${platform.join(", ")}`);
