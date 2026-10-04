# Message Board

This OpenAgent plugin provides the Codex agent message-board model over a
portable stdio MCP server. Install the `message-board` directory from
OpenAgent's plugin settings. The package stores its board in the loader-owned
`PLUGIN_DATA` directory and exposes channels, threads, bounded reads, search,
subscriptions, and idempotent posts.

The package requires Node.js 18 or newer and has no npm dependencies. Each call
supplies an `agent_id`, normally the caller's absolute subagent path. Agent IDs
are caller-supplied labels, not authenticated identities. The portable MCP
boundary cannot wake an idle subagent: `agents_to_notify` is persisted and
returned as handoff metadata while turn lifecycle remains host-owned.

The board belongs to the application's plugin data directory and is shared by
all MCP processes using that directory. Use distinct channel names for different
workspaces; transient host context is not used to select a separate board or
authenticate an agent identity.
`workspace` in the manifest does not create per-workspace storage. State must
never be written inside the installed package or a fallback working directory.

Thread results expose the root once in `root_post`; `results`, `reply_count`,
and `latest_reply` describe replies only. Channel ordering follows last activity.
Subscription records track the last matching root or reply without delivering
host notifications. Message text is preserved, including leading/trailing
whitespace. Posts accept at most 64 KiB of UTF-8 text. Reads return at most
8,000 UTF-8 bytes of serialized result data, automatically reducing page and
preview sizes. Continue with `next_cursor` or `next_offset_chars` until done;
character offsets count Unicode code points, including emoji, rather than bytes.

All tool inputs are validated before mutation. OpenAgent's optional `_openagent`
host context is accepted as transient metadata and excluded from persisted board
state and request fingerprints. It does not authenticate `agent_id`. Business
failures use MCP `isError` results; unsupported tools/methods use JSON-RPC errors. Versions
2024-11-05, 2025-03-26, and 2025-06-18 are negotiated during initialization.
Repeated posts with the same author and `request_id` reuse the original result;
different input with that identity is rejected, including after server restart.
Existing version-one boards and legacy request keys remain readable.

Every board operation holds an exclusive `board.lock`, reloads the latest
snapshot, and replaces `board.json` atomically. This prevents independent MCP
processes from overwriting one another's writes. A busy lock returns a retryable
error after three seconds. A crashed process can leave a lock behind: stop all
servers sharing that data directory, preserve `board.json`, then remove only
`board.lock` and restart. The server does not guess away a lock owned by another
process. Invalid JSON or an unsupported board version returns an error and
preserves the file for recovery; it never resets user data.

Run package verification with `node --test tests/*.test.mjs`, then
run the current `openagent-plugin-kit/scripts/validate-plugin.mjs` against this
directory. Install a staged copy in a fresh `OPENAGENT_HOME` for Runtime
qualification; source edits require reinstalling that copy. Verify all nine
tools, disable/re-enable, and uninstall/reinstall with retained `plugin-data`.

## Languages

Version 1.1.0 declares English and Chinese metadata and operational notices in
`extensions.openagent.i18n`. OpenAgent displays those declarations before and
after installation. Each request reads the SDK's live `_openagent.locale`
context. This also works when process network access is restricted. Independent
process calls without that context query the authenticated version-one
`locale.get` Host Bridge operation; standalone calls otherwise use English.
Resolution uses exact locale, supported base language, then declared default.
Switching language changes future notices without restarting the server. User
messages, IDs, stored data, and retry fingerprints retain their original values.
The bundled dependency-free host client is MIT licensed in `lib/LICENSE-MIT`.

Validate with the current plugin-kit using `--require-i18n` and, for an official
release, `--locales=<keys from OpenAgent src/lib/platformLocales.json>`. Record
both package and SDK revisions and inspect both plugin tabs in light/dark themes
while switching languages in both directions. A declaration alone does not
qualify a release. Older SDK versions without `locale.get` are not qualified for
this version's live-language behavior.
