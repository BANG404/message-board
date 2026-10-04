import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { errorNotice, requestLocale } from "../bin/i18n.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
);
const i18n = manifest.extensions.openagent.i18n;
test("every declared language has complete metadata and matching notice parameters", () => {
  const baseline = Object.keys(i18n.translations[i18n.default_locale]).sort();
  for (const tag of i18n.supported_locales) {
    const messages = i18n.translations[tag];
    assert.deepEqual(Object.keys(messages).sort(), baseline);
    for (const key of baseline) {
      assert.ok(messages[key].trim(), `${tag}:${key}`);
      const parameters = (text) =>
        [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(
        parameters(messages[key]),
        parameters(i18n.translations[i18n.default_locale][key]),
      );
    }
  }
});
test("notices resolve exact, base and default locales while keeping IDs unchanged", async () => {
  assert.equal(await requestLocale({ _openagent: { locale: "zh-CN" } }), "zh");
  assert.equal(await requestLocale({ _openagent: { locale: "fr" } }), "en");
  assert.equal(
    errorNotice(new Error("channel not found: 用户频道"), "zh"),
    "找不到频道：用户频道",
  );
  assert.equal(
    errorNotice(new Error("text is required"), "en"),
    "text is required",
  );
  assert.equal(
    errorNotice(new Error("text is required"), "zh"),
    "必须填写 text",
  );
  assert.match(
    errorNotice(
      Object.assign(new Error("storage unavailable"), { code: "EACCES" }),
      "zh",
    ),
    /无法访问.*EACCES/,
  );
});
