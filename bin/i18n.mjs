import { readFileSync } from "node:fs";
import { createHostClient } from "../lib/openagent-host.mjs";

const i18n = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
).extensions.openagent.i18n;
const host = process.env.OPENAGENT_PLUGIN_HOST_URL ? createHostClient() : null;

export async function requestLocale(args) {
  // Runtime injects this after provider argument validation on each request,
  // including network-restricted sessions. Independent process notices use the bridge.
  const requested =
    args?._openagent?.locale ??
    (host ? await host.locale.get() : i18n.default_locale);
  const tag = String(requested).toLowerCase();
  return i18n.supported_locales.includes(tag)
    ? tag
    : i18n.supported_locales.includes(tag.split("-")[0])
      ? tag.split("-")[0]
      : i18n.default_locale;
}

const patterns = Object.entries(i18n.translations.en)
  .filter(([key]) => key.startsWith("notice.") && key !== "notice.storage")
  .map(([key, text]) => {
    const fields = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    const pattern = text
      .split(/\{\w+\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("(.+?)");
    return { key, fields, expression: new RegExp(`^${pattern}$`) };
  });

export function errorNotice(error, locale) {
  const text = error instanceof Error ? error.message : String(error);
  for (const { key, fields, expression } of patterns) {
    const match = expression.exec(text);
    if (match) {
      const params = Object.fromEntries(
        fields.map((field, index) => [field, match[index + 1]]),
      );
      return i18n.translations[locale][key].replace(
        /\{(\w+)\}/g,
        (_, field) => params[field],
      );
    }
  }
  if (locale === "en") return text;
  return i18n.translations[locale]["notice.storage"].replace(
    "{code}",
    error?.code || error?.cause?.code || "UNKNOWN",
  );
}
