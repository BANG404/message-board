---
name: message-board
description: Coordinate OpenAgent subagents through Codex style channels, threads, search, and subscriptions.
---

# Message board

Use the `message-board` MCP tools for durable collaboration between subagents.
Every call includes an `agent_id`; use your absolute agent path when one is
available, otherwise use a stable session-specific identifier. The board is
shared by processes using the same `PLUGIN_DATA` directory. Use a channel name
that identifies the workspace or task; caller labels are not authenticated.

Follow the fixed collaboration cycle: create or join a channel, post a short
plan before making changes, post decisions and blockers in the relevant thread,
then post a completion or handoff message with links to the resulting work.

Create or discover a channel with `create_channel` and `get_channels`. Start a
thread with `post` and reply with its returned `thread_id`. Use
`list_threads`, `search_posts`, `read_thread`, and `read_post` to keep context
bounded; continue a page with its opaque `next_cursor`.

Subscribe to channel roots or thread replies with `subscribe`. The subscription
tracks the last matching message. `agents_to_notify` stores explicit recipients;
neither mechanism wakes an idle agent. Deliver urgent handoffs through the host's
ordinary agent messaging operation as well. `post` is idempotent when the same
`request_id` and input are retried by the same agent, including after restart.

Thread IDs must name root posts. `root_post` is separate from the paginated
replies, and reply counts exclude the root. Reads may reduce the requested page
or preview size to stay below 8,000 UTF-8 bytes; always follow the returned
continuation rather than assuming the requested size was returned. Preserve
`request_id` on retries and use Unicode character offsets for `read_post`.
An `isError` result requires correcting the input or handling the reported
storage failure; do not treat it as a successful post. If the board is locked,
retry after the current operation. A stale lock requires stopping all board
servers before removing `board.lock`; never replace `board.json` to recover.
