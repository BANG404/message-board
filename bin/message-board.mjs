#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const MAX_PAGE = 50;
const MAX_TEXT = 64 * 1024;
const MAX_OUTPUT = 8000;
const dataRoot = process.env.PLUGIN_DATA;
if (!dataRoot)
  throw new Error(
    "PLUGIN_DATA is required; start through the plugin loader or supply an isolated data directory",
  );
const statePath = join(dataRoot, "board.json");
const lockPath = join(dataRoot, "board.lock");
const specs = {
  create_channel: [
    "Create a channel and subscribe the caller to new roots.",
    {
      agent_id: { type: "string" },
      channel_name: { type: "string" },
      subscribe: { type: "boolean" },
    },
    ["agent_id", "channel_name"],
  ],
  get_channels: [
    "List channels, most recently active first.",
    {
      agent_id: { type: "string" },
      query: { type: "string" },
      recent_first: { type: "boolean" },
      limit: { type: "integer", minimum: 1 },
      cursor: { type: "string" },
    },
    ["agent_id"],
  ],
  list_threads: [
    "List a channel's threads with bounded previews.",
    {
      agent_id: { type: "string" },
      channel_name: { type: "string" },
      sort: { type: "string", enum: ["created", "activity"] },
      recent_first: { type: "boolean" },
      limit: { type: "integer", minimum: 1 },
      cursor: { type: "string" },
      max_chars_per_post: { type: "integer", minimum: 1 },
    },
    ["agent_id", "channel_name"],
  ],
  search_posts: [
    "Search posts and replies by case-insensitive substring.",
    {
      agent_id: { type: "string" },
      channel_name: { type: "string" },
      query: { type: "string" },
      after_message_id: { type: "string" },
      author: { type: "string" },
      limit: { type: "integer", minimum: 1 },
      cursor: { type: "string" },
      max_chars_per_post: { type: "integer", minimum: 1 },
    },
    ["agent_id"],
  ],
  read_thread: [
    "Read a thread by root post ID with bounded previews.",
    {
      agent_id: { type: "string" },
      thread_id: { type: "string" },
      limit: { type: "integer", minimum: 1 },
      cursor: { type: "string" },
      max_chars_per_post: { type: "integer", minimum: 1 },
    },
    ["agent_id", "thread_id"],
  ],
  read_post: [
    "Read a post with Unicode character offsets.",
    {
      agent_id: { type: "string" },
      message_id: { type: "string" },
      offset_chars: { type: "integer", minimum: 0 },
      limit_chars: { type: "integer", minimum: 1 },
    },
    ["agent_id", "message_id"],
  ],
  subscribe: [
    "Subscribe an agent to channel roots or thread replies.",
    {
      agent_id: { type: "string" },
      channel_name: { type: "string" },
      thread_id: { type: "string" },
      target_agent: { type: "string" },
    },
    ["agent_id"],
  ],
  unsubscribe: [
    "Unsubscribe an agent from channel roots or thread replies.",
    {
      agent_id: { type: "string" },
      channel_name: { type: "string" },
      thread_id: { type: "string" },
      target_agent: { type: "string" },
    },
    ["agent_id"],
  ],
  post: [
    "Start or reply to a thread. Exactly one destination is required.",
    {
      agent_id: { type: "string" },
      text: { type: "string" },
      channel_name: { type: "string" },
      new_channel_name: { type: "string" },
      thread_id: { type: "string" },
      agents_to_notify: { type: "array", items: { type: "string" } },
      request_id: { type: "string" },
    },
    ["agent_id", "text"],
  ],
};
let state;
const empty = () => ({
  version: 1,
  channels: {},
  posts: [],
  subscriptions: [],
  requests: {},
});
const fail = (message) => {
  throw new Error(message);
};
const req = (args, key) => {
  if (typeof args[key] !== "string" || !args[key].trim())
    fail(`${key} is required`);
  if (key !== "text" && args[key].length > 256)
    fail(`${key} exceeds 256 characters`);
  return args[key].trim();
};
const capped = (value, fallback = 20, max = MAX_PAGE) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1) fail("limit must be a positive integer");
  return Math.min(n, max);
};
const chars = (text) => Array.from(text);
const preview = (post, max = 1000) => {
  const all = chars(post.text);
  const text_preview = all.slice(0, max).join("");
  return {
    message_id: post.id,
    channel_name: post.channel_name,
    author: post.author,
    thread_id: post.thread_id,
    created_at: post.created_at,
    text_preview,
    n_chars: all.length,
    truncated: all.length > max,
  };
};
const metadata = (post) => ({
  message_id: post.id,
  channel_name: post.channel_name,
  author: post.author,
  thread_id: post.thread_id,
  created_at: post.created_at,
});
const postById = (id) =>
  state.posts.find((post) => post.id === id) || fail(`post not found: ${id}`);
const channel = (name) =>
  Object.hasOwn(state.channels, name)
    ? state.channels[name]
    : fail(`channel not found: ${name}`);
const page = (items, args) => {
  const decoded = args.cursor
    ? Buffer.from(args.cursor, "base64url").toString()
    : "0";
  if (
    !/^(0|[1-9][0-9]*)$/.test(decoded) ||
    (args.cursor && Buffer.from(decoded).toString("base64url") !== args.cursor)
  )
    fail("invalid cursor");
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset)) fail("invalid cursor");
  const n = capped(args.limit);
  const results = items.slice(offset, offset + n);
  return {
    results,
    n_returned: results.length,
    has_more: offset + results.length < items.length,
    next_cursor:
      offset + results.length < items.length
        ? Buffer.from(String(offset + results.length)).toString("base64url")
        : null,
  };
};
const newest = (items, recent = true) =>
  (recent ? [...items].reverse() : [...items]).sort((a, b) =>
    recent
      ? b.created_at.localeCompare(a.created_at)
      : a.created_at.localeCompare(b.created_at),
  );
const sub = (agent, channel_name, thread_id) =>
  state.subscriptions.find(
    (item) =>
      item.agent_id === agent &&
      item.channel_name === channel_name &&
      (item.thread_id || null) === (thread_id || null),
  );
const setSub = (agent, channel_name, thread_id, enabled) => {
  const item = sub(agent, channel_name, thread_id) || {
    agent_id: agent,
    channel_name,
    thread_id: thread_id || null,
    enabled: false,
    last_message_id: null,
  };
  item.enabled = enabled;
  if (!sub(agent, channel_name, thread_id)) state.subscriptions.push(item);
  return item;
};
async function load() {
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
    if (state?.version !== 1) fail("unsupported board version");
    if (
      !state.channels ||
      Array.isArray(state.channels) ||
      typeof state.channels !== "object" ||
      !Array.isArray(state.posts) ||
      !Array.isArray(state.subscriptions) ||
      !state.requests ||
      Array.isArray(state.requests) ||
      typeof state.requests !== "object"
    )
      fail("invalid board data; preserve board.json for recovery");
    // Null prototypes preserve version-one data while accepting arbitrary channel names.
    state.channels = Object.assign(Object.create(null), state.channels);
    state.requests = Object.assign(Object.create(null), state.requests);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    state = empty();
    state.channels = Object.create(null);
    state.requests = Object.create(null);
  }
}
async function save() {
  const tmp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, statePath);
  } finally {
    await unlink(tmp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
async function locked(operation) {
  await mkdir(dirname(statePath), { recursive: true });
  const deadline = Date.now() + 3000;
  let lock;
  while (!lock) {
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Diagnose a completed owner record when its process no longer exists.
      // A blank/incomplete record is never guessed away while an owner may be writing it.
      const owner = await readFile(lockPath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      const pid = Number(owner);
      if (/^[1-9][0-9]*\n$/.test(owner) && Number.isSafeInteger(pid)) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") {
            // Rename is avoided: a waiter must never steal a newly acquired lock.
            // Dead-owner recovery requires an explicit operator action; report it safely.
            fail(
              `board.lock belongs to stopped process ${pid}; remove that lock with all board servers stopped`,
            );
          }
        }
      }
      if (Date.now() >= deadline)
        fail("board is locked; retry after the current write completes");
      await delay(20);
    }
  }
  try {
    await lock.writeFile(`${process.pid}\n`);
    await load();
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
function validate(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    fail("arguments must be an object");
  const [, properties, required] = specs[name];
  for (const key of required) req(args, key);
  for (const [key, value] of Object.entries(args)) {
    if (key === "_openagent") {
      if (!value || typeof value !== "object" || Array.isArray(value))
        fail("_openagent must be an object");
      continue;
    }
    const property = properties[key];
    if (!property) fail(`unknown argument: ${key}`);
    if (property.type === "integer") {
      if (!Number.isInteger(value) || value < property.minimum)
        fail(`${key} must be an integer >= ${property.minimum}`);
    } else if (property.type === "array") {
      if (
        !Array.isArray(value) ||
        value.length > 20 ||
        value.some(
          (item) =>
            typeof item !== "string" || !item.trim() || item.length > 256,
        )
      )
        fail(`${key} must contain at most 20 non-empty agent IDs`);
    } else if (typeof value !== property.type)
      fail(`${key} must be ${property.type}`);
    if (property.enum && !property.enum.includes(value))
      fail(`${key} is invalid`);
    if (
      property.type === "string" &&
      !["text", "query", "cursor"].includes(key)
    )
      req(args, key);
  }
}
function destination(args, agent) {
  const values = [
    args.channel_name,
    args.new_channel_name,
    args.thread_id,
  ].filter((value) => value !== undefined);
  if (values.length !== 1) fail("exactly one destination is required");
  if (args.new_channel_name) {
    const name = req(args, "new_channel_name");
    if (state.channels[name]) fail("channel already exists");
    state.channels[name] = {
      created_at: new Date().toISOString(),
      created_by: agent,
      message_ids: [],
    };
    setSub(agent, name, null, true);
    return { channel_name: name, thread_id: null };
  }
  if (args.channel_name) {
    const name = req(args, "channel_name");
    channel(name);
    return { channel_name: name, thread_id: null };
  }
  const root = postById(req(args, "thread_id"));
  if (root.id !== root.thread_id) fail("thread_id must identify a root post");
  return { channel_name: root.channel_name, thread_id: root.thread_id };
}
async function call(name, args) {
  const agent = req(args, "agent_id");
  if (!specs[name]) fail(`unknown tool: ${name}`);
  if (name === "create_channel") {
    const channel_name = req(args, "channel_name");
    if (state.channels[channel_name]) fail("channel already exists");
    const created_at = new Date().toISOString();
    state.channels[channel_name] = {
      created_at,
      created_by: agent,
      message_ids: [],
    };
    setSub(agent, channel_name, null, args.subscribe !== false);
    await save();
    return {
      channel_name,
      created_at,
      created_by: agent,
      message_count: 0,
      last_message_id: null,
    };
  }
  if (name === "get_channels") {
    let items = Object.entries(state.channels).map(([channel_name, value]) => ({
      channel_name,
      created_at: value.created_at,
      created_by: value.created_by,
      message_count: value.message_ids.length,
      last_message_id: value.message_ids.at(-1) || null,
    }));
    if (args.query)
      items = items.filter((item) =>
        item.channel_name.toLowerCase().includes(args.query.toLowerCase()),
      );
    const activity = (item) =>
      item.last_message_id
        ? postById(item.last_message_id).created_at
        : item.created_at;
    items.sort((a, b) =>
      args.recent_first === false
        ? activity(a).localeCompare(activity(b))
        : activity(b).localeCompare(activity(a)),
    );
    return page(items, args);
  }
  if (name === "list_threads") {
    const ch = channel(req(args, "channel_name"));
    const roots = ch.message_ids
      .map(postById)
      .filter((post) => post.id === post.thread_id);
    const items = roots.map((root) => {
      const replies = state.posts.filter(
        (post) => post.thread_id === root.id && post.id !== root.id,
      );
      const latest = newest(replies)[0];
      return {
        thread_id: root.id,
        root_post: preview(root, capped(args.max_chars_per_post, 1000, 20000)),
        reply_count: replies.length,
        last_activity_at: latest?.created_at || root.created_at,
        latest_reply: latest
          ? preview(latest, capped(args.max_chars_per_post, 1000, 20000))
          : null,
      };
    });
    items.sort((a, b) =>
      args.sort === "activity"
        ? b.last_activity_at.localeCompare(a.last_activity_at)
        : b.root_post.created_at.localeCompare(a.root_post.created_at),
    );
    if (args.recent_first === false) items.reverse();
    return page(items, args);
  }
  if (name === "search_posts") {
    let items = state.posts;
    if (args.channel_name)
      items = items.filter((post) => post.channel_name === args.channel_name);
    if (args.author)
      items = items.filter((post) => post.author === args.author);
    if (args.after_message_id) {
      const after = state.posts.indexOf(postById(args.after_message_id));
      items = items.filter((post) => state.posts.indexOf(post) > after);
    }
    if (args.query)
      items = items.filter((post) =>
        post.text.toLocaleLowerCase().includes(args.query.toLocaleLowerCase()),
      );
    return page(
      newest(items).map((post) =>
        preview(post, capped(args.max_chars_per_post, 1000, 20000)),
      ),
      args,
    );
  }
  if (name === "read_thread") {
    const root = postById(req(args, "thread_id"));
    if (root.id !== root.thread_id) fail("thread_id must identify a root post");
    const replies = newest(
      state.posts.filter(
        (post) => post.thread_id === root.id && post.id !== root.id,
      ),
    ).map((post) =>
      preview(post, capped(args.max_chars_per_post, 1000, 20000)),
    );
    return {
      root_post: preview(root, capped(args.max_chars_per_post, 1000, 20000)),
      ...page(replies, args),
    };
  }
  if (name === "read_post") {
    const post = postById(req(args, "message_id"));
    const all = chars(post.text);
    const offset =
      args.offset_chars === undefined ? 0 : Number(args.offset_chars);
    if (!Number.isInteger(offset) || offset < 0)
      fail("offset_chars must be non-negative");
    const text = all
      .slice(offset, offset + capped(args.limit_chars, 20000, 20000))
      .join("");
    return {
      ...metadata(post),
      text,
      n_chars: all.length,
      next_offset_chars: offset + chars(text).length,
    };
  }
  if (name === "subscribe" || name === "unsubscribe") {
    const hasChannel = Boolean(args.channel_name);
    const hasThread = Boolean(args.thread_id);
    if (Number(hasChannel) + Number(hasThread) !== 1)
      fail("exactly one of channel_name or thread_id is required");
    const root = hasThread ? postById(args.thread_id) : null;
    if (root && root.id !== root.thread_id)
      fail("thread_id must identify a root post");
    const channel_name = args.channel_name || root.channel_name;
    channel(channel_name);
    const target_agent = args.target_agent?.trim() || agent;
    const item = setSub(
      target_agent,
      channel_name,
      root?.thread_id || null,
      name === "subscribe",
    );
    await save();
    return {
      channel_name: item.channel_name,
      thread_id: item.thread_id,
      target_agent,
      enabled: item.enabled,
      last_message_id: item.last_message_id,
    };
  }
  req(args, "text");
  const text = args.text;
  if (Buffer.byteLength(text) > MAX_TEXT) fail("text exceeds 64 KiB UTF-8");
  const request_id = args.request_id?.trim() || randomUUID();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        text,
        channel_name: args.channel_name,
        new_channel_name: args.new_channel_name,
        thread_id: args.thread_id,
        agents_to_notify: args.agents_to_notify || [],
      }),
    )
    .digest("hex");
  const key = JSON.stringify([agent, request_id]);
  // Version-one boards used colon-delimited keys. Retain retries for that author's entries.
  const legacy =
    state.requests[`${agent}:${request_id}`]?.metadata.author === agent
      ? state.requests[`${agent}:${request_id}`]
      : undefined;
  const prior = state.requests[key] || legacy;
  if (prior) {
    const legacyFingerprint =
      prior === legacy
        ? createHash("sha256")
            .update(
              JSON.stringify({
                text: text.trim(),
                channel_name: args.channel_name,
                new_channel_name: args.new_channel_name,
                thread_id: args.thread_id,
                agents_to_notify: args.agents_to_notify || [],
              }),
            )
            .digest("hex")
        : null;
    if (
      prior.fingerprint !== fingerprint &&
      prior.fingerprint !== legacyFingerprint
    )
      fail("request_id was reused with different input");
    return prior.metadata;
  }
  const target = destination(args, agent);
  const id = randomUUID();
  const post = {
    id,
    channel_name: target.channel_name,
    author: agent,
    thread_id: target.thread_id || id,
    created_at: new Date().toISOString(),
    text,
    agents_to_notify: args.agents_to_notify || [],
  };
  const result = { ...metadata(post), agents_to_notify: post.agents_to_notify };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT)
    fail("notification metadata exceeds result budget");
  state.posts.push(post);
  state.channels[target.channel_name].message_ids.push(id);
  setSub(agent, target.channel_name, post.thread_id, true);
  for (const subscription of state.subscriptions) {
    if (
      subscription.enabled &&
      subscription.channel_name === post.channel_name &&
      (subscription.thread_id === post.thread_id ||
        (!subscription.thread_id && post.id === post.thread_id))
    )
      subscription.last_message_id = id;
  }
  state.requests[key] = { fingerprint, metadata: result };
  await save();
  return result;
}
const toolList = () =>
  Object.entries(specs).map(([name, [description, properties, required]]) => ({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        ...properties,
        _openagent: {
          type: "object",
          description:
            "Optional transient host context supplied by OpenAgent; not persisted by this server.",
        },
      },
      required,
      additionalProperties: false,
    },
  }));
async function handle(request) {
  if (request.method === "initialize")
    return {
      protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(
        request.params?.protocolVersion,
      )
        ? request.params.protocolVersion
        : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "message-board", version: "1.0.1" },
    };
  if (["notifications/initialized", "ping"].includes(request.method)) return {};
  if (request.method === "tools/list") return { tools: toolList() };
  if (request.method === "tools/call") {
    const name = req(request.params || {}, "name");
    if (!Object.hasOwn(specs, name)) fail(`unknown tool: ${name}`);
    try {
      const args = request.params?.arguments ?? {};
      validate(name, args);
      return await locked(async () => {
        let bounded = { ...args };
        while (true) {
          const result = await call(name, bounded);
          const text = JSON.stringify(result);
          if (Buffer.byteLength(text) <= MAX_OUTPUT)
            return {
              content: [{ type: "text", text }],
              structuredContent: result,
            };
          // Recompute reads with smaller limits, retaining an accurate continuation cursor.
          if (name === "read_post") {
            if (capped(bounded.limit_chars, 20000, 20000) === 1)
              fail("result metadata exceeds 8,000 bytes");
            bounded.limit_chars = Math.max(
              1,
              Math.floor(capped(bounded.limit_chars, 20000, 20000) / 2),
            );
          } else if (
            [
              "get_channels",
              "list_threads",
              "read_thread",
              "search_posts",
            ].includes(name)
          ) {
            if (capped(bounded.limit) > 1)
              bounded.limit = Math.max(
                1,
                Math.floor(capped(bounded.limit) / 2),
              );
            else if (
              name !== "get_channels" &&
              capped(bounded.max_chars_per_post, 1000, 20000) > 1
            )
              bounded.max_chars_per_post = Math.max(
                1,
                Math.floor(capped(bounded.max_chars_per_post, 1000, 20000) / 2),
              );
            else fail("result metadata exceeds 8,000 bytes");
          } else fail("result exceeds 8,000 bytes");
        }
      });
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  }
  throw Object.assign(new Error(`unsupported method: ${request.method}`), {
    rpcCode: -32601,
  });
}
const reply = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });
const error = (id, message, code = -32602) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
for await (const line of input) {
  if (!line.trim()) continue;
  let request;
  try {
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${error(null, "Parse error", -32700)}\n`);
      continue;
    }
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string"
    ) {
      process.stdout.write(
        `${error(request?.id ?? null, "Invalid request", -32600)}\n`,
      );
      continue;
    }
    if (request.id === undefined) continue;
    const result = await handle(request);
    if (request.id !== undefined)
      process.stdout.write(`${reply(request.id, result)}\n`);
  } catch (err) {
    if (request?.id !== undefined)
      process.stdout.write(
        `${error(request.id, err instanceof Error ? err.message : String(err), err.rpcCode || -32602)}\n`,
      );
  }
}
