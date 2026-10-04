import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

const server = new URL("../bin/message-board.mjs", import.meta.url);

async function connect(data) {
  const child = spawn("node", [server.pathname.replace(/^\/([A-Z]:)/, "$1")], {
    env: { ...process.env, PLUGIN_DATA: data },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0;
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });
  async function request(method, params) {
    const requestId = ++id;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`RPC timeout: ${stderr}`)),
        5000,
      );
      pending.set(requestId, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`,
    );
    return result;
  }
  async function call(name, args = {}) {
    const response = await request("tools/call", {
      name,
      arguments: { agent_id: "/root", ...args },
    });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.notEqual(
      response.result.isError,
      true,
      JSON.stringify(response.result),
    );
    assert.ok(Buffer.byteLength(response.result.content[0].text) <= 8000);
    return response.result.structuredContent;
  }
  return {
    request,
    call,
    async close() {
      const exited = once(child, "exit");
      child.stdin.end();
      await exited;
    },
  };
}

async function fixture(t) {
  const data = await mkdtemp(join(tmpdir(), "message-board-test-"));
  const client = await connect(data);
  t.after(async () => {
    await client.close();
    await rm(data, { recursive: true, force: true });
  });
  return { data, client };
}

test("MCP schemas declare every required property and initialize negotiates version", async (t) => {
  const { client } = await fixture(t);
  const initialized = await client.request("initialize", {
    protocolVersion: "2024-11-05",
  });
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  const listed = await client.request("tools/list");
  assert.equal(listed.result.tools.length, 9);
  for (const tool of listed.result.tools) {
    for (const property of tool.inputSchema.required) {
      assert.ok(
        property in tool.inputSchema.properties,
        `${tool.name}: ${property}`,
      );
    }
  }
});

test("all nine tools support channels, replies, search, Unicode reads and subscriptions", async (t) => {
  const { client, data } = await fixture(t);
  await client.call("create_channel", { channel_name: "开发" });
  assert.equal(
    (await client.call("get_channels", { query: "开发" })).n_returned,
    1,
  );
  const root = await client.call("post", {
    channel_name: "开发",
    text: "😀😀😀a",
    request_id: "root",
  });
  let threads = await client.call("list_threads", {
    channel_name: "开发",
    max_chars_per_post: 2,
  });
  assert.equal(threads.results[0].reply_count, 0);
  assert.equal(threads.results[0].latest_reply, null);
  assert.equal(threads.results[0].root_post.text_preview, "😀😀");
  assert.equal(threads.results[0].root_post.truncated, true);
  await client.call("subscribe", {
    thread_id: root.thread_id,
    target_agent: "/root/reviewer",
  });
  const reply = await client.call("post", {
    agent_id: "/root/worker",
    thread_id: root.thread_id,
    text: "Ready 子任务",
    agents_to_notify: ["/root/reviewer"],
    request_id: "reply",
  });
  assert.deepEqual(reply.agents_to_notify, ["/root/reviewer"]);
  const thread = await client.call("read_thread", {
    thread_id: root.thread_id,
  });
  assert.equal(thread.results.length, 1);
  assert.equal(thread.results[0].message_id, reply.message_id);
  threads = await client.call("list_threads", { channel_name: "开发" });
  assert.equal(threads.results[0].reply_count, 1);
  assert.equal(
    (
      await client.call("search_posts", {
        query: "READY",
        author: "/root/worker",
      })
    ).n_returned,
    1,
  );
  assert.equal(
    (
      await client.call("read_post", {
        message_id: root.message_id,
        offset_chars: 1,
        limit_chars: 2,
      })
    ).text,
    "😀😀",
  );
  assert.equal(
    (
      await client.call("unsubscribe", {
        thread_id: root.thread_id,
        target_agent: "/root/reviewer",
      })
    ).enabled,
    false,
  );
  const state = JSON.parse(await readFile(join(data, "board.json"), "utf8"));
  assert.deepEqual(state.posts.at(-1).agents_to_notify, ["/root/reviewer"]);
  assert.equal(
    state.subscriptions.find((entry) => entry.agent_id === "/root/reviewer")
      .last_message_id,
    reply.message_id,
  );
});

test("pagination and UTF-8 response budgets preserve complete reads", async (t) => {
  const { client } = await fixture(t);
  await client.call("create_channel", { channel_name: "large" });
  const text = "中😀".repeat(8000);
  const root = await client.call("post", { channel_name: "large", text });
  await client.call("post", { thread_id: root.thread_id, text: "reply 1" });
  await client.call("post", { thread_id: root.thread_id, text: "reply 2" });
  const first = await client.call("read_thread", {
    thread_id: root.thread_id,
    limit: 1,
    max_chars_per_post: 1,
  });
  assert.equal(first.has_more, true);
  const next = await client.call("read_thread", {
    thread_id: root.thread_id,
    limit: 1,
    cursor: first.next_cursor,
    max_chars_per_post: 1,
  });
  assert.equal(next.has_more, false);
  assert.notEqual(first.results[0].message_id, next.results[0].message_id);
  let reconstructed = "";
  let offset = 0;
  while (offset < Array.from(text).length) {
    const read = await client.call("read_post", {
      message_id: root.message_id,
      offset_chars: offset,
    });
    assert.ok(read.next_offset_chars > offset);
    reconstructed += read.text;
    offset = read.next_offset_chars;
  }
  assert.equal(reconstructed, text);
});

test("invalid inputs return tool errors without modifying board or poisoning later writes", async (t) => {
  const { client, data } = await fixture(t);
  await client.call("create_channel", { channel_name: "safe" });
  const before = await readFile(join(data, "board.json"), "utf8");
  for (const args of [
    { channel_name: "safe", new_channel_name: "other", text: "bad" },
    { new_channel_name: "other", text: "bad", agents_to_notify: "invalid" },
    { channel_name: "safe", text: "bad", extra: true },
  ]) {
    const response = await client.request("tools/call", {
      name: "post",
      arguments: { agent_id: "/root", ...args },
    });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, true);
    assert.equal(await readFile(join(data, "board.json"), "utf8"), before);
  }
  await client.call("post", { channel_name: "safe", text: "good" });
  assert.equal((await client.call("get_channels")).n_returned, 1);
});

test("restart preserves posts and idempotency, including legacy version-one data", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "message-board-restart-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await writeFile(
    join(data, "board.json"),
    JSON.stringify({
      version: 1,
      channels: {},
      posts: [],
      subscriptions: [],
      requests: {},
    }),
  );
  let client = await connect(data);
  const args = {
    new_channel_name: "persist",
    text: "Original",
    request_id: "retry",
  };
  let root;
  try {
    root = await client.call("post", args);
  } finally {
    await client.close();
  }
  client = await connect(data);
  try {
    assert.deepEqual(await client.call("post", args), root);
    const rejected = await client.request("tools/call", {
      name: "post",
      arguments: { agent_id: "/root", ...args, text: "Changed" },
    });
    assert.equal(rejected.result.isError, true);
    assert.equal(
      (await client.call("read_post", { message_id: root.message_id })).text,
      "Original",
    );
    assert.equal(
      (await client.call("get_channels")).results[0].message_count,
      1,
    );
  } finally {
    await client.close();
  }
});

test("independent MCP processes share durable writes without losing channels", async (t) => {
  const { client, data } = await fixture(t);
  const other = await connect(data);
  try {
    await Promise.all([
      client.call("post", { new_channel_name: "first", text: "one" }),
      other.call("post", { new_channel_name: "second", text: "two" }),
    ]);
    assert.equal((await client.call("get_channels")).n_returned, 2);
    assert.equal((await other.call("get_channels")).n_returned, 2);
  } finally {
    await other.close();
  }
});

test("channel names and request IDs cannot collide through object prototypes or delimiters", async (t) => {
  const { client } = await fixture(t);
  await client.call("create_channel", { channel_name: "__proto__" });
  const first = await client.call("post", {
    agent_id: "a:b",
    request_id: "c",
    channel_name: "__proto__",
    text: "one",
  });
  const second = await client.call("post", {
    agent_id: "a",
    request_id: "b:c",
    channel_name: "__proto__",
    text: "two",
  });
  assert.notEqual(first.message_id, second.message_id);
  assert.equal((await client.call("get_channels")).results[0].message_count, 2);
});

test("corrupt and unsupported data stay untouched and recover after restoration", async (t) => {
  const { client, data } = await fixture(t);
  await client.call("create_channel", { channel_name: "retained" });
  const path = join(data, "board.json");
  const good = await readFile(path, "utf8");
  for (const bad of [
    "{broken",
    JSON.stringify({ version: 2 }),
    JSON.stringify({ version: 1, channels: {}, posts: null }),
  ]) {
    await writeFile(path, bad);
    const result = await client.request("tools/call", {
      name: "create_channel",
      arguments: { agent_id: "/root", channel_name: "bad" },
    });
    assert.equal(result.result.isError, true);
    assert.equal(await readFile(path, "utf8"), bad);
  }
  await writeFile(path, good);
  await client.call("create_channel", { channel_name: "recovered" });
  assert.equal((await client.call("get_channels")).n_returned, 2);
});

test("busy board gives a recoverable error without deleting another process's lock", async (t) => {
  const { client, data } = await fixture(t);
  const lock = join(data, "board.lock");
  await writeFile(lock, `${process.pid}\n`);
  const response = await client.request("tools/call", {
    name: "get_channels",
    arguments: { agent_id: "/root" },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /locked/);
  assert.equal(await readFile(lock, "utf8"), `${process.pid}\n`);
  await rm(lock);
  assert.equal((await client.call("get_channels")).n_returned, 0);
});

test("invalid cursors and reply destinations fail while original text is preserved", async (t) => {
  const { client } = await fixture(t);
  const root = await client.call("post", {
    new_channel_name: "format",
    text: "  formatted\n",
  });
  const reply = await client.call("post", {
    thread_id: root.thread_id,
    text: "reply",
  });
  for (const [name, args] of [
    ["get_channels", { cursor: "." }],
    ["subscribe", { thread_id: reply.message_id }],
    ["post", { thread_id: reply.message_id, text: "bad destination" }],
  ]) {
    const response = await client.request("tools/call", {
      name,
      arguments: { agent_id: "/root", ...args },
    });
    assert.equal(response.result.isError, true);
  }
  assert.equal(
    (await client.call("read_post", { message_id: root.message_id })).text,
    "  formatted\n",
  );
  const unknown = await client.request("nonexistent");
  assert.equal(unknown.error.code, -32601);
});

test("OpenAgent's injected host context is accepted but never persisted or part of idempotency", async (t) => {
  const { client, data } = await fixture(t);
  const args = {
    new_channel_name: "host",
    text: "context-free content",
    request_id: "host-post",
  };
  const first = await client.call("post", {
    ...args,
    _openagent: {
      conversation_id: "first-conversation",
      workspace: "test-workspace",
    },
  });
  const retry = await client.call("post", {
    ...args,
    _openagent: { conversation_id: "second-conversation" },
  });
  assert.equal(first.message_id, retry.message_id);
  const persisted = await readFile(join(data, "board.json"), "utf8");
  assert.ok(!persisted.includes("first-conversation"));
  assert.ok(!persisted.includes("test-workspace"));
  assert.ok(!persisted.includes("_openagent"));
});

test("populated legacy boards preserve original post identities and retry fingerprints", async (t) => {
  const { client, data } = await fixture(t);
  const created_at = "2026-01-01T00:00:00.000Z";
  const metadata = {
    message_id: "legacy-root",
    channel_name: "legacy",
    author: "/root",
    thread_id: "legacy-root",
    created_at,
  };
  const args = {
    channel_name: "legacy",
    text: "  original\n",
    request_id: "retry",
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        text: args.text.trim(),
        channel_name: args.channel_name,
        agents_to_notify: [],
      }),
    )
    .digest("hex");
  const legacy = {
    version: 1,
    channels: {
      legacy: { created_at, created_by: "/root", message_ids: ["legacy-root"] },
    },
    posts: [
      {
        id: "legacy-root",
        channel_name: "legacy",
        author: "/root",
        thread_id: "legacy-root",
        created_at,
        text: "original",
      },
    ],
    subscriptions: [],
    requests: { "/root:retry": { fingerprint, metadata } },
  };
  const path = join(data, "board.json");
  await writeFile(path, JSON.stringify(legacy));
  assert.deepEqual(await client.call("post", args), metadata);
  assert.equal(
    (await client.call("read_post", { message_id: "legacy-root" })).text,
    "original",
  );
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), legacy);
});
