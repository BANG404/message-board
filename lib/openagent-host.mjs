/**
 * Dependency-free capability client for the OpenAgent plugin host bridge.
 *
 * The Runtime exposes this same boundary to every installed package. It owns
 * agent execution, checkpoints, permissions, and cancellation; a package
 * composes these modules into its own state machine and persists its own
 * domain state below PLUGIN_DATA.
 */

const URL_ENV = "OPENAGENT_PLUGIN_HOST_URL";
const TOKEN_ENV = "OPENAGENT_PLUGIN_HOST_TOKEN";
const ID_ENV = "OPENAGENT_PLUGIN_ID";
const DEFAULT_TIMEOUT_MS = 15_000;

export class OpenAgentHostError extends Error {
  constructor(message, { status = 0, operation = "", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OpenAgentHostError";
    this.status = status;
    this.operation = operation;
  }
}

function jsonObject(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} must be a non-empty string`);
  return text;
}

function optionalText(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return String(value).trim();
}

function requiredEnvironment(environment, name) {
  const value = String(environment?.[name] ?? "").trim();
  if (!value) throw new OpenAgentHostError(`${name} is not set`);
  return value;
}

function pluginIdentity(explicit, environment) {
  return explicit === undefined
    ? requiredEnvironment(environment, ID_ENV)
    : requiredText(explicit, "plugin id");
}

function alias(source, canonical, ...names) {
  if (source[canonical] !== undefined) return source[canonical];
  for (const name of names) {
    if (source[name] !== undefined) return source[name];
  }
  return undefined;
}

function flowShape(value, pluginId) {
  const source = jsonObject(value, "flow projection");
  const candidate = source.flow && typeof source.flow === "object" ? source.flow : source;
  const state = candidate.state && typeof candidate.state === "object"
    ? { ...candidate.state }
    : { ...candidate };
  delete state.kind;
  delete state.state;
  if (!state.plugin_id) state.plugin_id = pluginId;
  if (state.plugin_id !== pluginId) {
    throw new OpenAgentHostError("flow projection belongs to another plugin");
  }
  return { kind: "plugin", state };
}

/** Normalize the bridge snake_case request and SDK camelCase aliases. */
function agentRequest(value) {
  const outer = jsonObject(value, "agent request");
  const source = outer.request && typeof outer.request === "object" && !Array.isArray(outer.request)
    ? outer.request
    : outer;
  const request = { ...source };
  const fields = [
    ["conv_id", "convId", "conversationId", "conversation_id"],
    ["parent_checkpoint_id", "parentCheckpointId"],
    ["branch_id", "branchId"],
    ["model_binding", "modelBinding"],
    ["user_message_id", "userMessageId"],
    ["assistant_message_id", "assistantMessageId"],
  ];
  for (const [canonical, ...names] of fields) {
    const value = alias(source, canonical, ...names);
    if (value !== undefined) request[canonical] = value;
    for (const name of names) delete request[name];
  }
  request.conv_id = requiredText(request.conv_id, "conv_id");
  request.text = requiredText(request.text, "text");
  return request;
}

function conversationId(value, label = "conv_id") {
  if (typeof value === "string") return requiredText(value, label);
  const source = jsonObject(value, "conversation arguments");
  return requiredText(source.convId ?? source.conv_id ?? source.conversationId ?? source.conversation_id, label);
}

function branchId(value, label = "branch_id") {
  return requiredText(value?.branchId ?? value?.branch_id ?? value, label);
}

function parseHookPayload(value) {
  const payload = typeof value === "string" ? JSON.parse(value) : jsonObject(value, "hook payload");
  const event = payload.event && typeof payload.event === "object" && !Array.isArray(payload.event)
    ? payload.event
    : payload;
  return { payload, event };
}

/** Extract opaque MCP turn context supplied by OpenAgent. */
export function context(args = {}) {
  const outer = jsonObject(args, "tool arguments");
  const source = outer._openagent && typeof outer._openagent === "object" ? outer._openagent : outer;
  const result = {
    conversationId: optionalText(source.conversation_id ?? source.conversationId ?? outer.conversation_id ?? outer.conversationId),
    branchId: optionalText(source.branch_id ?? source.branchId ?? outer.branch_id ?? outer.branchId),
    workspace: String(source.workspace ?? outer.workspace ?? ""),
  };
  const parentConversationId = optionalText(source.parent_conv_id ?? source.parentConvId ?? outer.parent_conv_id ?? outer.parentConvId);
  const roleId = optionalText(source.role_id ?? source.roleId ?? outer.role_id ?? outer.roleId);
  if (parentConversationId) result.parentConversationId = parentConversationId;
  if (roleId) result.roleId = roleId;
  return result;
}

export const pluginContext = context;

export function requireConversationContext(args = {}) {
  const value = context(args);
  if (!value.conversationId) {
    throw new OpenAgentHostError("OpenAgent did not provide a conversation context");
  }
  return value;
}

/** Read an automation hook's nested event without exposing its envelope shape. */
export function hookEvent(value) {
  return parseHookPayload(value).event;
}

export function hookContext(value, { requiredConversation = true } = {}) {
  const event = hookEvent(value);
  const result = context({ _openagent: event });
  if (requiredConversation && !result.conversationId) {
    throw new OpenAgentHostError("OpenAgent did not provide a hook conversation context");
  }
  return result;
}

/** Create the generic capability client used by every package. */
export function createHostClient({
  environment = process.env,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  url,
  token,
  pluginId,
} = {}) {
  const bridgeUrl = requiredText(url ?? environment?.[URL_ENV], "host bridge URL");
  const bridgeToken = requiredText(token ?? environment?.[TOKEN_ENV], "host bridge token");
  const identity = pluginIdentity(pluginId, environment);
  if (typeof fetchImpl !== "function") throw new OpenAgentHostError("fetch is unavailable");
  const requestTimeout = Number.isFinite(timeoutMs) ? Math.max(1, Number(timeoutMs)) : DEFAULT_TIMEOUT_MS;

  async function call(operation, args = {}) {
    const name = requiredText(operation, "host operation");
    const requestArgs = { ...jsonObject(args, "host arguments"), plugin_id: identity };
    const controller = new AbortController();
    let timer;
    try {
      const request = fetchImpl(bridgeUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridgeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation: name, args: requestArgs }),
        signal: controller.signal,
      });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error(`host operation timed out: ${name}`);
          error.name = "AbortError";
          reject(error);
        }, requestTimeout);
      });
      const response = await Promise.race([request, timeout]);
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) {
        throw new OpenAgentHostError(
          String(body?.error ?? `host operation failed: ${response.status}`),
          { status: response.status, operation: name },
        );
      }
      return body.result;
    } catch (error) {
      if (error instanceof OpenAgentHostError) throw error;
      if (error?.name === "AbortError") {
        throw new OpenAgentHostError(`host operation timed out: ${name}`, { operation: name, cause: error });
      }
      throw new OpenAgentHostError(
        error instanceof Error ? error.message : String(error),
        { operation: name, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  const conversation = {
    create(value = {}) {
      const source = jsonObject(value, "conversation arguments");
      return call("conversation.create", {
        title: requiredText(source.title, "title"),
        workspace: source.workspace ?? "",
        parent_conv_id: alias(source, "parent_conv_id", "parentConvId") ?? null,
        role_id: alias(source, "role_id", "roleId") ?? null,
      });
    },
    state(value, selectedBranchId = undefined) {
      if (typeof value === "string") {
        return call("conversation.state", {
          conv_id: requiredText(value, "conv_id"),
          ...(selectedBranchId === undefined ? {} : { branch_id: selectedBranchId }),
        });
      }
      const source = jsonObject(value, "conversation arguments");
      const selected = alias(source, "branch_id", "branchId");
      return call("conversation.state", {
        conv_id: conversationId(source),
        ...(selected === undefined ? {} : { branch_id: selected }),
      });
    },
    children(value, options = {}) {
      if (typeof value === "string") {
        return call("conversation.children", {
          ...jsonObject(options, "conversation children arguments"),
          parent_conv_id: requiredText(value, "parent_conv_id"),
        });
      }
      const source = jsonObject(value, "conversation children arguments");
      return call("conversation.children", {
        ...(source.workspace === undefined ? {} : { workspace: source.workspace }),
        parent_conv_id: requiredText(alias(source, "parent_conv_id", "parentConvId"), "parent_conv_id"),
      });
    },
    update(value, patch = {}) {
      const source = typeof value === "string"
        ? { ...jsonObject(patch, "conversation patch"), conv_id: value }
        : jsonObject(value, "conversation patch");
      const result = { conv_id: conversationId(source) };
      for (const [canonical, ...names] of [["title"], ["title_source", "titleSource"], ["pinned"], ["updated_at", "updatedAt"]]) {
        const value = alias(source, canonical, ...names);
        if (value !== undefined) result[canonical] = canonical === "pinned" ? Boolean(value) : value;
      }
      return call("conversation.update", result);
    },
    cancel(value) {
      return call("conversation.cancel", { conv_id: conversationId(value) });
    },
    delete(value) {
      return call("conversation.delete", { conv_id: conversationId(value) });
    },
    setFlow(value, selectedBranchId, projection) {
      const source = typeof value === "string"
        ? { conv_id: value, branch_id: selectedBranchId, flow: projection }
        : jsonObject(value, "conversation flow arguments");
      const selected = alias(source, "branch_id", "branchId");
      return call("conversation.flow.set", {
        conv_id: conversationId(source),
        branch_id: branchId({ branchId: selected }),
        flow: flowShape(source.flow ?? source.state ?? source, identity),
      });
    },
  };

  const branch = {
    create(value = {}) {
      const source = jsonObject(value, "branch arguments");
      return call("branch.create", {
        conv_id: conversationId(source),
        ...(source.id ? { id: source.id } : {}),
        parent_branch_id: alias(source, "parent_branch_id", "parentBranchId") ?? null,
        forked_from_checkpoint_id: alias(source, "forked_from_checkpoint_id", "forkedFromCheckpointId") ?? null,
        forked_from_message_id: alias(source, "forked_from_message_id", "forkedFromMessageId") ?? null,
      });
    },
    list(value) {
      return call("branch.list", { conv_id: conversationId(value) });
    },
    setHead(value, checkpoint) {
      const source = typeof value === "string" ? { branch_id: value, checkpoint_id: checkpoint } : jsonObject(value, "branch head arguments");
      return call("branch.head.set", {
        branch_id: branchId({ branchId: alias(source, "branch_id", "branchId") }),
        checkpoint_id: requiredText(alias(source, "checkpoint_id", "checkpointId"), "checkpoint_id"),
      });
    },
    setActive(value, checkpoint) {
      const source = typeof value === "string" ? { conv_id: value, checkpoint_id: checkpoint } : jsonObject(value, "branch active arguments");
      return call("branch.active.set", {
        conv_id: conversationId(source),
        checkpoint_id: requiredText(alias(source, "checkpoint_id", "checkpointId"), "checkpoint_id"),
      });
    },
  };

  function agentCall(operation, value = {}, options = {}) {
    const request = agentRequest(value);
    const outer = jsonObject(value, "agent request");
    const optionObject = jsonObject(options, "agent options");
    const flow = optionObject.flow ?? outer.flow ?? request.flow;
    delete request.flow;
    const result = { ...request };
    if (flow !== undefined) result.flow = flowShape(flow, identity);
    const hidden = optionObject.hidden ?? outer.hidden;
    if (hidden !== undefined) result.hidden = Boolean(hidden);
    const wait = optionObject.wait ?? outer.wait;
    if (wait !== undefined) result.wait = Boolean(wait);
    return call(operation, result);
  }

  const agent = {
    submit: (value = {}, options = {}) => agentCall("agent.submit", value, options),
    wake: (value = {}, options = {}) => agentCall("agent.wake", value, options),
  };
  const roles = {
    list(value = {}) {
      const workspace = typeof value === "string" ? value : jsonObject(value, "roles arguments").workspace;
      return call("roles.list", workspace === undefined ? {} : { workspace });
    },
  };
  const event = {
    emit(nameOrValue, payload) {
      const source = typeof nameOrValue === "string" ? { name: nameOrValue, payload } : jsonObject(nameOrValue, "event arguments");
      return call("event.emit", { name: requiredText(source.name, "event name"), payload: source.payload ?? null });
    },
  };

  const locale = {
    async get() {
      const result = await call("locale.get");
      if (result?.version !== 1 || typeof result.locale !== "string" || !result.locale) {
        throw new OpenAgentHostError("unsupported host locale response");
      }
      return result.locale;
    },
  };
  return Object.freeze({ pluginId: identity, call, conversation, branch, agent, roles, event, locale });
}

/** The longer name is used by reference templates; keep both spellings stable. */
export const createPluginHost = createHostClient;

let defaultClient;
function lazyDefaultClient() {
  return defaultClient ??= createHostClient();
}

/** Importing the module does not require bridge environment variables. */
export const openagent = new Proxy({}, {
  get(_target, property) {
    return lazyDefaultClient()[property];
  },
});
