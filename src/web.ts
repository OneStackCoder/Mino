import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  RemoveMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { applyProxy, checkpointer, createMinoAgent, type MinoAgent } from "./agent.ts";
import {
  loadModelProfiles,
  saveModelProfiles,
  loadSettings,
  saveSettings,
  parseSearch,
  MODEL_CATALOG,
  PERMISSION_LEVELS,
  SESSIONS_FILE,
  CONFIG_DIR,
  loadWorkspaces,
  saveWorkspaces,
  type AgentConfig,
  type AppSettings,
  type ModelProfile,
  type ModelProfilesState,
  type PermissionLevel,
  type ProxyConfig,
  type ProxyProtocol,
  type SearchSettings,
  type Theme,
  type WorkspaceMeta,
  type WorkspacesState,
} from "./config.ts";

// cwd 由启动器固定为 app 目录（开发模式则为项目根），public/ 与 node_modules/ 均在此目录下
const ROOT = process.cwd();
const INDEX_FILE = path.join(ROOT, "public", "index.html");
// 固定映射表，不开放任意路径读取（防目录穿越）
const VENDOR: Record<string, readonly [string, string]> = {
  "/vendor/marked.js": [
    path.join(ROOT, "node_modules", "marked", "lib", "marked.umd.js"),
    "application/javascript; charset=utf-8",
  ],
  "/vendor/purify.min.js": [
    path.join(ROOT, "node_modules", "dompurify", "dist", "purify.min.js"),
    "application/javascript; charset=utf-8",
  ],
  "/vendor/katex.min.js": [
    path.join(ROOT, "node_modules", "katex", "dist", "katex.min.js"),
    "application/javascript; charset=utf-8",
  ],
  "/vendor/katex/katex.min.css": [
    path.join(ROOT, "node_modules", "katex", "dist", "katex.min.css"),
    "text/css; charset=utf-8",
  ],
  "/vendor/marked-katex.js": [
    path.join(ROOT, "node_modules", "marked-katex-extension", "lib", "index.umd.js"),
    "application/javascript; charset=utf-8",
  ],
  "/vendor/xterm.js": [
    path.join(ROOT, "node_modules", "@xterm", "xterm", "lib", "xterm.js"),
    "application/javascript; charset=utf-8",
  ],
  "/vendor/xterm.css": [
    path.join(ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css"),
    "text/css; charset=utf-8",
  ],
};
// KaTeX 字体按前缀映射（katex.min.css 内部以相对路径 fonts/ 引用）
const KATEX_FONTS_PREFIX = "/vendor/katex/fonts/";
const FONT_MIME: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

const PROVIDER_IDS = new Set(MODEL_CATALOG.map((p) => p.id));

// 前端可见的模型配置（不含 apiKey）
interface PublicModelProfile {
  id: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  hasKey: boolean;
}

interface PublicModelsState {
  activeId: string;
  items: PublicModelProfile[];
}

const publicModels = (state: ModelProfilesState): PublicModelsState => ({
  activeId: state.activeId,
  items: state.items.map((m) => ({
    id: m.id,
    provider: m.provider,
    model: m.model,
    baseUrl: m.baseUrl ?? null,
    hasKey: !!m.apiKey,
  })),
});

// 去掉 id，转成构建 agent / 模型用的配置
const toAgentConfig = (profile: ModelProfile): AgentConfig => {
  const config: AgentConfig = {
    provider: profile.provider,
    model: profile.model,
    apiKey: profile.apiKey,
  };
  if (profile.baseUrl) config.baseUrl = profile.baseUrl;
  return config;
};

// 前端经 RPC 提交的配置输入（桥接层无法保证形状，需运行时校验）
interface ConfigInput {
  provider?: unknown;
  model?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
}

// ---------- 校验前端提交的配置 ----------
// Base URL 必须是 http(s) 地址，允许带路径（如 /v1）
function isHttpUrl(value: string): boolean {
  // 显式要求 //：new URL("http:/host") 也会解析成功，必须先按字面量拦掉
  if (!/^https?:\/\/[^\s/]+/i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.host;
  } catch {
    return false;
  }
}

// 同一提供商重新配置时，apiKey 留空沿用已保存的 Key
function normalizeConfigInput(
  input: ConfigInput,
  current: AgentConfig | null
): AgentConfig {
  const provider =
    typeof input?.provider === "string" && PROVIDER_IDS.has(input.provider)
      ? input.provider
      : null;
  const model = typeof input?.model === "string" ? input.model.trim() : "";
  let apiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
  const baseUrl = typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!provider) throw new Error("未知的模型提供商");
  if (!model) throw new Error("模型名不能为空");
  // API Key 允许为空（本地网关通常无需鉴权）；同一提供商留空时沿用已保存的 Key
  if (!apiKey && current?.provider === provider) apiKey = current.apiKey;
  if (provider === "custom") {
    if (!baseUrl) throw new Error("自定义接口必须填写 Base URL");
    if (!isHttpUrl(baseUrl)) {
      throw new Error("Base URL 不合法，需以 http:// 或 https:// 开头，如 https://api.example.com/v1");
    }
  }
  const next: AgentConfig = { provider, model, apiKey };
  if (provider === "custom") next.baseUrl = baseUrl;
  return next;
}

// ---------- 校验前端提交的新增工作区 ----------
// 相对路径按用户主目录解析（与默认工作区 ~/mino/... 同一基准）；
// 返回 { name, dir }：名称留空时取目录 basename
function normalizeWorkspaceInput(
  input: unknown
): { name: string; dir: string } {
  const m = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const name = typeof m.name === "string" ? m.name.trim() : "";
  const rawDir = typeof m.path === "string" ? m.path.trim() : "";
  if (!rawDir) throw new Error("目录路径不能为空");
  const dir = path.resolve(os.homedir(), rawDir); // 绝对路径原样，相对路径基于主目录
  const stat = fs.existsSync(dir) ? fs.statSync(dir) : null;
  if (stat && !stat.isDirectory()) throw new Error("路径已存在且不是目录");
  return { name: name || path.basename(dir) || dir, dir };
}

// ---------- 校验前端提交的应用设置（代理 / 主题 / 搜索） ----------
// 搜索设置是否发生变化（变化后需重建 agent 才能生效）：顺序即优先级，顺序变化也要重建
function sameSearch(a: SearchSettings, b: SearchSettings): boolean {
  return (
    a.engines.join() === b.engines.join() &&
    a.mode === b.mode &&
    a.bochaApiKey === b.bochaApiKey
  );
}

// current 作为兜底：前端漏传字段时保留现有值，避免静默降级
function normalizeSettingsInput(input: unknown, current: AppSettings): AppSettings {
  const m =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const theme: Theme = m.theme === "dark" ? "dark" : "light";
  const p =
    typeof m.proxy === "object" && m.proxy !== null
      ? (m.proxy as Record<string, unknown>)
      : {};
  const host = typeof p.host === "string" ? p.host.trim() : "";
  const port =
    typeof p.port === "number" && Number.isInteger(p.port) ? p.port : NaN;
  const protocol: ProxyProtocol = p.protocol === "socks5" ? "socks5" : "http";
  const username = typeof p.username === "string" ? p.username.trim() : "";
  const password = typeof p.password === "string" ? p.password : "";
  const proxy: ProxyConfig | null =
    host && port > 0 && port < 65536
      ? { protocol, host, port, username, password }
      : null;
  // 字号：12–20 之间的整数才接受，否则沿用现有值（首次为 undefined，前端用默认 15）
  const fsInput =
    typeof m.fontSize === "number" && Number.isFinite(m.fontSize)
      ? Math.floor(m.fontSize)
      : NaN;
  const fontSize = fsInput >= 12 && fsInput <= 20 ? fsInput : current.fontSize;
  // 面板宽度由专用 RPC setPanelWidth 维护；普通 setSettings（改主题/代理/字号）不得丢失它
  return {
    proxy,
    theme,
    panelWidth: current.panelWidth,
    fontSize,
    search: m.search === undefined ? current.search : parseSearch(m.search),
  };
}

// 推送给前端 window.onMinoAgentEvent 的事件（与 public/index.html 约定）
type UIEvent =
  | { type: "reasoning_start" }
  | { type: "reasoning_delta"; text: string }
  | { type: "answer_start" }
  | { type: "answer_delta"; text: string }
  | { type: "tool"; name: string; args: unknown }
  | { type: "tool_result"; name: string; text: string }
  | { type: "config"; provider: string; model: string }
  // 权限确认请求：Agent 暂停等待用户对这批文件操作逐个「允许 / 拒绝」
  | { type: "confirm_request"; calls: Array<{ name: string; args: unknown; description?: string }> }
  | { type: "done" }
  | { type: "error"; message: string };

// 用户对单个被拦截操作的确认结果（与 langchain HITL Decision 对齐）
type ConfirmDecision = { type: "approve" } | { type: "reject"; message?: string };

// 单次流式运行结果：正常结束，或因权限确认中断（需带 decisions 用 Command 恢复）
type RunChatResult =
  | { status: "done" }
  | { status: "confirm"; calls: Array<{ name: string; args: unknown; description?: string }> };

interface RunChatStreamParams {
  agent: MinoAgent;
  // 首次调用传新消息；从中断恢复时传 Command({ resume: { decisions } })
  input: { messages: Array<{ role: "user"; content: string }> } | Command<Record<string, unknown>>;
  push: (ev: UIEvent) => void;
  threadId: string;
}

const chunkText = (content: MessageContent): string =>
  typeof content === "string"
    ? content
    : (content ?? []).map((c) => ("text" in c ? c.text ?? "" : "")).join("");

// 提取思维链增量：DeepSeek / OpenAI 兼容接口放在 additional_kwargs.reasoning_content，
// Anthropic 扩展思考以 content 里的 thinking 块下发
function messageReasoning(msg: {
  content: MessageContent;
  additional_kwargs?: Record<string, unknown>;
}): string {
  const kw = msg.additional_kwargs?.reasoning_content;
  let text = typeof kw === "string" ? kw : "";
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block == null || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "thinking" && typeof b.thinking === "string") text += b.thinking;
    }
  }
  return text;
}

// ---------- 消费 Agent 双通道流并转为 UI 事件 ----------
// messages 通道：逐 token 增量（打字机效果，约 60ms 合并一批推送）
// updates 通道：完整消息（工具事件）；对话历史由 checkpointer 按 thread 维护，不再外部回放
async function runChatStream({
  agent,
  input,
  push,
  threadId,
}: RunChatStreamParams): Promise<RunChatResult> {
  let pending = "";
  let pendingReasoning = ""; // 思考增量与正文增量各自缓冲，共用一个 60ms 合批定时器
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushReasoning = () => {
    if (pendingReasoning) {
      push({ type: "reasoning_delta", text: pendingReasoning });
      pendingReasoning = "";
    }
  };
  const flushDelta = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushReasoning(); // 思考在前：前端先收尾思考面板再渲染正文
    if (pending) {
      push({ type: "answer_delta", text: pending });
      pending = "";
    }
  };
  const queueDelta = (text: string) => {
    pending += text;
    if (!flushTimer) flushTimer = setTimeout(flushDelta, 60);
  };
  const queueReasoning = (text: string) => {
    pendingReasoning += text;
    if (!flushTimer) flushTimer = setTimeout(flushDelta, 60);
  };
  // 权限确认中断：本轮被拦截的文件操作（humanInTheLoopMiddleware 产生）
  let confirmCalls: Array<{ name: string; args: unknown; description?: string }> = [];
  try {
    // 首次调用传新消息（完整历史在 agent 内部 state），从中断恢复时传 Command
    // recursionLimit 提高到 100：搜索 + 逐页抓正文属于正常多步工作流，LangGraph 默认 25 太小
    const stream = await agent.stream(input, {
      configurable: { thread_id: threadId },
      streamMode: ["messages", "updates"],
      recursionLimit: 100,
    });
    let segStarted = false;
    let reasoningStarted = false;
    let lastGenId: string | null = null;
    for await (const [mode, payload] of stream) {
      if (mode === "messages") {
        const [chunk] = payload as unknown[];
        // 跳过 human 回显；tool 完整结果走 updates 通道
        if (!(chunk instanceof AIMessageChunk)) continue;
        // 新的一次模型生成（工具调用后再次生成）→ 换一段新回答
        if (chunk.id && chunk.id !== lastGenId) {
          flushDelta(); // 收尾上一段
          lastGenId = chunk.id;
          segStarted = false;
          reasoningStarted = false;
        }
        const reasoning = messageReasoning(chunk);
        if (reasoning) {
          if (!reasoningStarted) {
            reasoningStarted = true;
            push({ type: "reasoning_start" });
          }
          queueReasoning(reasoning);
        }
        const text = chunkText(chunk.content);
        if (text) {
          if (!segStarted) {
            flushDelta(); // 先推完缓冲的思考增量：前端据此折叠思考面板
            segStarted = true;
            push({ type: "answer_start" });
          }
          queueDelta(text);
        }
      } else {
        const updates = payload as Record<string, unknown>;
        // 权限确认中断：updates 通道带 __interrupt__ 键，value 为 HITL 请求（含被拦截的调用清单）
        if (Array.isArray(updates["__interrupt__"])) {
          for (const intr of updates["__interrupt__"] as Array<{ value?: unknown }>) {
            const v = intr?.value;
            if (v == null || typeof v !== "object") continue;
            const req = v as { type?: unknown; actionRequests?: unknown };
            if (req.type !== "human_in_the_loop" || !Array.isArray(req.actionRequests)) continue;
            confirmCalls = req.actionRequests.flatMap((a): Array<{ name: string; args: unknown; description?: string }> => {
              if (a == null || typeof a !== "object") return [];
              const { name, args, description } = a as {
                name?: unknown; args?: unknown; description?: unknown;
              };
              return typeof name === "string"
                ? [{ name, args, description: typeof description === "string" ? description : undefined }]
                : [];
            });
          }
        }
        for (const [node, update] of Object.entries(updates)) {
          if (node === "__interrupt__") continue; // 中断键不含消息
          // 触发上下文压缩时，state 更新是 [RemoveMessage(清空), 摘要, ...重放的保留消息]
          // 从 remove 起跳过，避免摘要和旧消息在 UI 上重复推送
          let compacted = false;
          for (const msg of ((update as { messages?: BaseMessage[] }).messages) ?? []) {
            if (msg instanceof RemoveMessage) {
              compacted = true;
              continue;
            }
            if (compacted) continue;
            if (msg instanceof AIMessage && msg.tool_calls?.length) {
              flushDelta();
              for (const call of msg.tool_calls) {
                push({ type: "tool", name: call.name, args: call.args });
              }
            } else if (msg instanceof ToolMessage) {
              flushDelta();
              push({
                type: "tool_result",
                name: msg.name ?? "",
                text: String(msg.content).slice(0, 300),
              });
            }
          }
        }
      }
    }
    flushDelta();
  } catch (err) {
    flushDelta(); // 已收到的增量仍然保留给用户看
    throw err;
  } finally {
    if (flushTimer) clearTimeout(flushTimer);
  }
  // 图因权限确认暂停（流自然结束）：把被拦截的操作交给上层，等待用户 decisions 后恢复
  if (confirmCalls.length > 0) return { status: "confirm", calls: confirmCalls };
  return { status: "done" };
}

// ---------- 会话历史：元数据存 sessions.json，消息本体存 checkpointer ----------
// 会话 id 即 checkpointer 的 thread_id；标题取该会话首条消息
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 该会话的文件操作权限（旧数据缺省时按 workspace 处理） */
  permission: PermissionLevel;
}

// 前端渲染用的一条历史（user / 压缩摘要 / 一轮 assistant 的 UI 事件序列）
type HistoryItem =
  | { role: "user"; text: string }
  | { role: "summary"; text: string }
  | { role: "assistant"; events: UIEvent[] };

function loadSessions(): SessionMeta[] {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    if (!Array.isArray(data)) return [];
    return data.flatMap((s): SessionMeta[] => {
      if (typeof s !== "object" || s === null) return [];
      const m = s as Record<string, unknown>;
      if (typeof m.id !== "string" || typeof m.title !== "string") return [];
      return [
        {
          id: m.id,
          title: m.title,
          createdAt: typeof m.createdAt === "number" ? m.createdAt : 0,
          updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : 0,
          permission: PERMISSION_LEVELS.includes(m.permission as PermissionLevel)
            ? (m.permission as PermissionLevel)
            : "workspace",
        },
      ];
    });
  } catch {
    return []; // 文件不存在或损坏：从空列表开始
  }
}

function persistSessions(sessions: SessionMeta[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2) + "\n");
}

// 读取某个线程的完整消息序列
// 直接从 checkpointer 读取线程状态：不依赖 agent，未配置模型时也能回放历史
async function readThreadMessages(threadId: string): Promise<BaseMessage[]> {
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: threadId },
  });
  const values = (tuple?.checkpoint.channel_values ?? {}) as {
    messages?: BaseMessage[];
  };
  return values.messages ?? [];
}

// 把 checkpointer 里的消息序列转成前端可渲染的历史条目
// assistant 的 tool 调用/结果/文本合并为一组 UI 事件，与流式渲染共用同一套展示逻辑
function historyToItems(messages: BaseMessage[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  let aiEvents: UIEvent[] | null = null; // 当前 assistant 轮的事件缓冲
  const flushAi = () => {
    if (aiEvents && aiEvents.length) items.push({ role: "assistant", events: aiEvents });
    aiEvents = null;
  };
  for (const msg of messages) {
    if (msg instanceof HumanMessage) {
      flushAi();
      items.push({ role: "user", text: chunkText(msg.content) });
    } else if (
      msg instanceof AIMessage &&
      msg.additional_kwargs?.lc_source === "summarization"
    ) {
      // 上下文压缩产生的摘要消息（保留在 state 里供模型使用），单独成一条展示
      flushAi();
      items.push({ role: "summary", text: chunkText(msg.content) });
    } else if (msg instanceof AIMessage) {
      if (!aiEvents) aiEvents = [];
      // 思维链（落盘消息里保留的）先于正文/工具事件回放，与流式顺序一致
      const reasoning = messageReasoning(msg);
      if (reasoning) {
        aiEvents.push({ type: "reasoning_start" });
        aiEvents.push({ type: "reasoning_delta", text: reasoning });
      }
      for (const call of msg.tool_calls ?? []) {
        aiEvents.push({ type: "tool", name: call.name, args: call.args });
      }
      const text = chunkText(msg.content);
      if (text) {
        aiEvents.push({ type: "answer_start" });
        aiEvents.push({ type: "answer_delta", text });
      }
    } else if (msg instanceof ToolMessage) {
      if (!aiEvents) aiEvents = [];
      aiEvents.push({
        type: "tool_result",
        name: msg.name ?? "",
        text: String(msg.content).slice(0, 300),
      });
    }
  }
  flushAi();
  return items;
}

// 纯 Webview 方案：页面经 mino:// 自定义协议加载，不走 HTTP、不占端口
// 前端→原生：window.MinoAgent.*（expose RPC）；原生→前端流式推送：window.onMinoAgentEvent 回调
export function startWebUI(): void {
  (async () => {
    const mod = await import("@webviewjs/webview");
    const Application = mod.Application ?? mod.default?.Application;
    const app = new Application();
    const win = app.createBrowserWindow({
      title: "Mino",
      width: 1300,
      height: 900,
      logical: true, // 尺寸按逻辑像素解释：HiDPI（scaleFactor=2）下物理像素会被缩放一半
      resizable: true,
    });

    // Windows 的窗口图标默认取自宿主进程 node.exe，需要显式换成应用图标（传编码后的 PNG 由原生层解码）
    if (process.platform === "win32") {
      try {
        win.setWindowIcon(fs.readFileSync(path.join(ROOT, "public", "icon.png")));
      } catch {
        // 图标缺失不影响启动
      }
    }

    // 注册协议必须在 createWebview 之前
    win.registerProtocol("mino", async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(fs.readFileSync(INDEX_FILE), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const vendor = VENDOR[pathname];
      if (vendor) {
        return new Response(fs.readFileSync(vendor[0]), {
          headers: { "Content-Type": vendor[1] },
        });
      }
      if (pathname.startsWith(KATEX_FONTS_PREFIX)) {
        const rel = pathname.slice(KATEX_FONTS_PREFIX.length);
        if (rel && !rel.includes("..")) {
          const file = path.join(
            ROOT, "node_modules", "katex", "dist", "fonts", rel
          );
          return new Response(fs.readFileSync(file), {
            headers: {
              "Content-Type": FONT_MIME[path.extname(rel)] ?? "application/octet-stream",
            },
          });
        }
      }
      return new Response(`Not found: ${pathname}`, {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    });

    // 单一主界面 webview：工具面板是页面内右侧栏，不再需要第二个 webview。
    // 顶层 webview 省略 bounds，可自动填满窗口并跟随 resize
    // Windows 下 WebView2 默认把数据目录建在 node.exe 所在目录（C:\Program Files\nodejs），
    // 无写权限会直接报「无法读取和写入其数据目录」，改为指向 %LOCALAPPDATA%\Mino
    let webContext: ReturnType<typeof app.createWebContext> | undefined;
    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
      const dataDir = path.join(localAppData, "Mino");
      fs.mkdirSync(dataDir, { recursive: true });
      webContext = app.createWebContext({ dataDirectory: dataDir });
    }
    const webview = win.createWebview({ url: "mino://localhost/", webContext });

    // 弹出系统目录选择器：Linux 用 zenity（GTK 原生目录对话框）；其余平台回退为选文件取其所在目录
    const showDirectoryPicker = async (): Promise<string | null> => {
      if (process.platform === "linux") {
        return await new Promise<string | null>((resolve) => {
          execFile(
            "zenity",
            ["--file-selection", "--directory", "--title", "选择工作区目录"],
            (err, stdout) => {
              if (err) return resolve(null); // 用户取消或未安装 zenity
              const dir = String(stdout).trim();
              resolve(dir || null);
            }
          );
        });
      }
      const files = win.openFileDialog({ title: "请选择目标目录内的任意文件" });
      return files.length ? path.dirname(files[0]) : null;
    };

    const push = (ev: UIEvent) => {
      if (webview.isDisposed()) return;
      webview.evaluateScript(`window.onMinoAgentEvent?.(${JSON.stringify(ev)})`);
    };

    // 模型配置列表（可存多份，activeId 为当前生效的一份）
    let models: ModelProfilesState = loadModelProfiles();
    const activeProfile = (): ModelProfile | null =>
      models.items.find((m) => m.id === models.activeId) ?? null;
    const initialProfile = activeProfile();
    let config: AgentConfig | null = initialProfile ? toAgentConfig(initialProfile) : null;
    // 应用设置（代理 / 主题），独立于模型配置
    let settings: AppSettings = loadSettings();
    applyProxy(settings.proxy);
    // 工作区列表与当前选中项（元数据存 workspaces.json）；文件工具限定在活动工作区内
    let workspaces: WorkspacesState = loadWorkspaces();
    const activeWorkspace = (): WorkspaceMeta =>
      workspaces.items.find((w) => w.id === workspaces.activeId) ?? workspaces.items[0];
    // 文件操作权限：按会话独立设置（新会话默认 workspace），换会话 / 改权限时重建 agent
    let permission: PermissionLevel = "workspace";
    let agentPermission: PermissionLevel = "workspace"; // 当前 agent 构建时的权限，用于判断是否需要重建
    // 当前 agent 构建时的搜索设置：引擎开关固化在工具集里，变化后需重建（见 syncAgent）
    let agentSearch: SearchSettings = settings.search;
    let agent: MinoAgent | null = config ? createMinoAgent(config, activeWorkspace().path, permission, settings.search) : null;
    // 对话进行中改搜索设置 → 挂起，本轮结束后再重建，避免打断待恢复的权限确认流程
    let pendingSearchSync = false;
    // 当前会话线程 id：历史与压缩状态都挂在 checkpointer 的这个线程上
    let threadId: string = crypto.randomUUID();
    let sessions: SessionMeta[] = loadSessions();
    let sessionSaved = false; // 当前线程是否已写入会话列表（首条消息后写入）
    let busy = false;
    // 权限确认等待：chat 挂起等前端 resolveConfirm({ decisions }) 回传后恢复执行
    let confirmResolver: ((decisions: ConfirmDecision[]) => void) | null = null;

    // 工具面板（页面内右侧栏）：文件预览的尺寸限制
    const FILE_PREVIEW_LIMIT = 256 * 1024; // 文本预览上限，超出截断
    const FILE_REFUSE_LIMIT = 8 * 1024 * 1024; // 超过此大小直接拒绝预览

    // ---------- 工具面板：工作区文件浏览 API（限制在工作区内，防目录穿越） ----------
    const panelResolvePath = (rel: string): string => {
      const root = activeWorkspace().path;
      const abs = rel ? path.resolve(root, rel) : root;
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        throw new Error("路径超出工作区范围");
      }
      return abs;
    };

    const panelListDir = (rel: string) => {
      const abs = panelResolvePath(rel);
      const names = fs.readdirSync(abs, { withFileTypes: true });
      const entries = names
        .filter((n) => n.name !== "." && n.name !== "..")
        .map((n) => {
          let dir = n.isDirectory();
          let size = 0;
          let mtime = 0;
          try {
            const st = fs.statSync(path.join(abs, n.name));
            if (st.isDirectory()) dir = true;
            else {
              size = st.size;
              mtime = Math.round(st.mtimeMs);
            }
          } catch {
            // stat 失败（权限等）：保留 Dirent 类型信息，尺寸置零
          }
          return { name: n.name, dir, size, mtime };
        });
      // 目录在前，同类按名称排序（中文按本地习惯）
      entries.sort((a, b) =>
        a.dir !== b.dir ? Number(b.dir) - Number(a.dir) : a.name.localeCompare(b.name, "zh")
      );
      return { rel, entries };
    };

    const panelReadFile = (rel: string) => {
      const abs = panelResolvePath(rel);
      const stat = fs.statSync(abs); // 不存在时抛 ENOENT
      if (stat.isDirectory()) throw new Error("这是一个目录");
      if (stat.size > FILE_REFUSE_LIMIT) throw new Error("文件超过 8MB，不支持预览");
      const buf = fs.readFileSync(abs);
      // 二进制探测：文件头部 4KB 含 NUL 字节视为非文本
      if (buf.subarray(0, 4096).includes(0)) {
        return { name: path.basename(rel), size: stat.size, binary: true, truncated: false, text: "" };
      }
      const truncated = buf.length > FILE_PREVIEW_LIMIT;
      const text = (truncated ? buf.subarray(0, FILE_PREVIEW_LIMIT) : buf).toString("utf8");
      return { name: path.basename(rel), size: stat.size, binary: false, truncated, text };
    };

    // ---------- 工具面板：内嵌终端 ----------
    // 不用 node-pty（免原生编译）：Linux/macOS 用 script 分配伪 PTY（bash/zsh 有完整交互回显），
    // Windows 直接行缓冲 powershell。输出经 base64 推给 window.onTermEvent，输入经 termWrite 回传
    // 每个终端会话一个伪 PTY，以 id 隔离：工作区文件是唯一页签，终端可开多个
    interface TermSession {
      child: ReturnType<typeof spawn>;
    }
    const termSessions = new Map<string, TermSession>();
    process.once("exit", () => {
      for (const s of termSessions.values()) {
        if (s.child && !s.child.killed) {
          try {
            s.child.kill();
          } catch {
            /* 已退出 */
          }
        }
      }
    });

    const pushTerm = (id: string, ev: Record<string, unknown>) => {
      if (webview.isDisposed()) return;
      webview.evaluateScript(`window.onTermEvent?.(${JSON.stringify({ id, ...ev })})`);
    };

    const termStart = (id: string, cols: number, rows: number): { running: boolean; id: string } => {
      const existing = termSessions.get(id);
      if (existing && !existing.child.killed) return { running: true, id }; // 复用已存活的会话
      const cwd = activeWorkspace().path;
      const env = {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: String(cols),
        LINES: String(rows),
      };
      let child: ReturnType<typeof spawn>;
      if (process.platform === "win32") {
        // windowsHide 防止在 GUI 进程里新建控制台窗口
        child = spawn("powershell.exe", ["-NoLogo"], { cwd, env, windowsHide: true });
      } else {
        // 先在 PTY 内同步窗口尺寸，再 exec 到平台默认 shell
        const shell = process.platform === "darwin" ? "zsh" : "bash";
        const inner = `stty rows ${rows} cols ${cols}; exec ${shell}`;
        child =
          process.platform === "darwin"
            ? spawn("script", ["-q", "/dev/null", "/bin/sh", "-c", inner], { cwd, env })
            : spawn("script", ["-qec", inner, "/dev/null"], { cwd, env });
      }
      termSessions.set(id, { child });
      if (child.stdout)
        child.stdout.on("data", (buf: Buffer) =>
          pushTerm(id, { type: "data", data: buf.toString("base64") })
        );
      if (child.stderr)
        child.stderr.on("data", (buf: Buffer) =>
          pushTerm(id, { type: "data", data: buf.toString("base64") })
        );
      child.on("exit", (code) => {
        if (termSessions.get(id)?.child === child) termSessions.delete(id);
        pushTerm(id, { type: "exit", code: code ?? 0 });
      });
      child.on("error", (err) => {
        if (termSessions.get(id)?.child === child) termSessions.delete(id);
        pushTerm(id, { type: "exit", code: -1, message: err.message });
      });
      return { running: true, id };
    };

    const termKill = (id: string) => {
      const s = termSessions.get(id);
      if (s && !s.child.killed) {
        try {
          s.child.kill();
        } catch {
          /* 进程已退出 */
        }
      }
      termSessions.delete(id);
    };

    // 从 RPC 入参解析终端会话 id，非法时直接抛错（前端必传）
    const parseTermId = (input: unknown): string => {
      const m =
        typeof input === "object" && input !== null
          ? (input as Record<string, unknown>)
          : {};
      const id = typeof m.id === "string" ? m.id : "";
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error("无效的终端会话 ID");
      return id;
    };

    // 拖拽/缩放后同步 PTY 尺寸：对 shell 的 tty 执行 stty，
    // TIOCSWINSZ 成功后内核自动向 PTY 前台进程组发 SIGWINCH（bash/vim 等即时感知）
    const runQuiet = (cmd: string, args: string[]) =>
      new Promise<string | null>((resolve) => {
        execFile(cmd, args, { timeout: 2000 }, (err, stdout) =>
          resolve(err ? null : String(stdout).trim())
        );
      });

    const termSyncSize = async (id: string, cols: number, rows: number): Promise<{ ok: boolean }> => {
      const s = termSessions.get(id);
      const pid = s?.child.pid;
      if (!s || s.child.killed || typeof pid !== "number") return { ok: false };
      if (process.platform === "win32") return { ok: true }; // 行缓冲模式无 PTY 尺寸概念
      let dev = "";
      if (process.platform === "darwin") {
        // 无 /proc：pgrep 找 script 的子进程，ps 查其 tty
        const child = await runQuiet("pgrep", ["-P", String(pid)]);
        const shellPid = child?.split(/\s+/)[0] ?? "";
        if (!/^\d+$/.test(shellPid)) return { ok: false };
        const tty = (await runQuiet("ps", ["-o", "tty=", "-p", shellPid])) ?? "";
        if (tty && tty !== "??") dev = "/dev/" + tty;
      } else {
        // Linux：/proc/<script>/children 给出 sh -c（已 exec 成 shell）的 pid，其 fd/0 即 PTY slave
        const children = fs
          .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (!children.length) return { ok: false };
        try {
          const fd0 = fs.readlinkSync(`/proc/${children[0]}/fd/0`);
          if (fd0.startsWith("/dev/")) dev = fd0;
        } catch {
          return { ok: false };
        }
      }
      if (!dev) return { ok: false };
      const stty = await runQuiet("stty", [
        process.platform === "darwin" ? "-f" : "-F",
        dev,
        "cols",
        String(cols),
        "rows",
        String(rows),
      ]);
      return { ok: stty !== null };
    };

    // 权限 / 搜索设置变化后重建 agent：interruptOn、系统提示词与工具集都是构建时固化的
    const syncAgent = () => {
      if (
        config &&
        (agentPermission !== permission || !sameSearch(agentSearch, settings.search))
      ) {
        agent = createMinoAgent(config, activeWorkspace().path, permission, settings.search);
        agentPermission = permission;
        agentSearch = settings.search;
      }
    };

    // 会话已落盘 → 更新活跃时间；未落盘 → 首条消息定标题并写入列表（带上当前权限）
    const touchSession = (firstMessage: string) => {
      const now = Date.now();
      if (!sessionSaved) {
        sessionSaved = true;
        sessions.unshift({
          id: threadId,
          title: firstMessage.replace(/\s+/g, " ").slice(0, 30),
          createdAt: now,
          updatedAt: now,
          permission,
        });
      } else {
        const meta = sessions.find((s) => s.id === threadId);
        if (meta) {
          meta.updatedAt = now;
          meta.permission = permission;
        }
      }
      persistSessions(sessions);
    };

    // ---------- 模型配置：多份保存，activeId 指向当前生效项 ----------
    // 写入文件并同步当前配置，返回前端可见状态（不含真实 Key）
    const persistModels = (): PublicModelsState => {
      saveModelProfiles(models);
      const profile = activeProfile();
      config = profile ? toAgentConfig(profile) : null;
      return publicModels(models);
    };

    // 当前配置变化后重建 agent 并开启新会话（旧会话仍保留在历史列表）
    const activateProfile = () => {
      permission = "workspace"; // 新会话回到默认权限
      agent = config ? createMinoAgent(config, activeWorkspace().path, permission, settings.search) : null;
      agentPermission = permission;
      agentSearch = settings.search;
      threadId = crypto.randomUUID();
      sessionSaved = false;
      if (config) push({ type: "config", provider: config.provider, model: config.model });
    };

    const parseProfileId = (input: unknown): string => {
      const id = typeof input === "string" ? input : "";
      if (!id) throw new Error("缺少模型配置 ID");
      return id;
    };

    const findProfile = (id: string): ModelProfile => {
      const profile = models.items.find((m) => m.id === id);
      if (!profile) throw new Error("模型配置不存在");
      return profile;
    };

    // 各提供商的 API 根地址（与 buildModel 里的接口地址一致），仅用于探测
    const PROBE_BASE_URL: Record<string, string> = {
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com/v1",
      deepseek: "https://api.deepseek.com",
      zhipu: "https://open.bigmodel.cn/api/paas/v4",
      moonshot: "https://api.moonshot.cn/v1",
      gemini: "https://generativelanguage.googleapis.com/v1beta", // 原生 models.list
    };

    // 用 GET /models 验证连通性与鉴权：不发起对话，不消耗 token
    const probeConnection = async (probe: AgentConfig) => {
      const base = (
        probe.provider === "custom" ? probe.baseUrl : PROBE_BASE_URL[probe.provider]
      )?.replace(/\/+$/, "");
      if (!base) throw new Error("请填写 Base URL");
      const key = probe.apiKey || "not-needed";
      const headers: Record<string, string> =
        probe.provider === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : probe.provider === "gemini"
            ? { "x-goog-api-key": key }
            : { Authorization: `Bearer ${key}` };
      let res: Response;
      try {
        res = await fetch(`${base}/models`, {
          headers,
          signal: AbortSignal.timeout(15000),
        });
      } catch (err) {
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw new Error("连接超时（15 秒）");
        }
        throw new Error(err instanceof Error ? err.message : "连接失败");
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200).trim();
        const reason = res.status === 401 || res.status === 403 ? "API Key 无效或无权限" : "接口返回错误";
        throw new Error(`${reason}（HTTP ${res.status}）${detail ? `：${detail}` : ""}`);
      }
      await res.body?.cancel(); // 只校验响应状态，不读取模型列表
    };

    // expose 的 stub 只注入当前页面，必须等页面加载完成后再注册
    webview.on("page-load-finished", () => {
      // 静态值 catalog/provider/model 同步可读；函数经 RPC 调用，返回值必须可 JSON 序列化
      webview.expose("MinoAgent", {
        catalog: MODEL_CATALOG,
        provider: config?.provider ?? null,
        model: config?.model ?? null,
        // ---------- 模型配置列表（多份，activeId 为当前生效项） ----------
        getModels() {
          return publicModels(models);
        },
        // 新增配置：列表为空时自动设为当前模型
        addModel(input: ConfigInput) {
          const profile: ModelProfile = {
            id: crypto.randomUUID(),
            ...normalizeConfigInput(input, null),
          };
          models.items.push(profile);
          if (!config) {
            models.activeId = profile.id;
            const state = persistModels();
            activateProfile();
            return state;
          }
          return persistModels();
        },
        // 编辑配置：改的是当前模型时立即生效并开启新会话
        updateModel(input: ConfigInput & { id?: unknown }) {
          const id = parseProfileId(input?.id);
          const index = models.items.findIndex((m) => m.id === id);
          if (index < 0) throw new Error("模型配置不存在");
          const next = normalizeConfigInput(input, models.items[index]);
          const wasActive = models.activeId === id;
          models.items[index] = { id, ...next };
          const state = persistModels();
          if (wasActive) activateProfile();
          return state;
        },
        // 删除配置：当前模型被删时自动启用列表第一项，全删完则回到未配置状态
        deleteModel(input: unknown) {
          const id = parseProfileId(input);
          const index = models.items.findIndex((m) => m.id === id);
          if (index < 0) throw new Error("模型配置不存在");
          const wasActive = models.activeId === id;
          models.items.splice(index, 1);
          if (!models.items.length) {
            models.activeId = "";
            const state = persistModels();
            agent = null;
            permission = "workspace";
            agentPermission = permission;
            threadId = crypto.randomUUID();
            sessionSaved = false;
            return state;
          }
          if (wasActive) models.activeId = models.items[0].id;
          const state = persistModels();
          if (wasActive) activateProfile();
          return state;
        },
        // 切换当前模型：重建 agent，开启新会话
        setActiveModel(input: unknown) {
          const id = parseProfileId(input);
          findProfile(id);
          if (id === models.activeId) return publicModels(models);
          models.activeId = id;
          const state = persistModels();
          activateProfile();
          return state;
        },
        // 用设置表单里的临时配置试探连接（id 用于沿用该条已保存的 Key）
        async testConnection(input: ConfigInput & { id?: unknown }) {
          const id = typeof input?.id === "string" ? input.id : "";
          // 仅编辑已保存配置时沿用其 Key；新增配置按表单实际填写测试
          const fallback = id ? models.items.find((m) => m.id === id) ?? null : null;
          await probeConnection(normalizeConfigInput(input, fallback));
          return { ok: true };
        },
        // 测试一条已保存配置（有真实 Key，前端无需回传）
        async testModel(input: unknown) {
          await probeConnection(toAgentConfig(findProfile(parseProfileId(input))));
          return { ok: true };
        },
        // ---------- 应用设置（代理 / 主题）：代理立即生效 ----------
        getSettings(): AppSettings {
          return settings;
        },
        setSettings(input: unknown) {
          const next = normalizeSettingsInput(input, settings);
          const searchChanged = !sameSearch(settings.search, next.search);
          saveSettings(next);
          settings = next;
          applyProxy(settings.proxy);
          // 搜索引擎开关固化在工具集里，变化后需重建 agent；对话进行中挂起到本轮结束
          if (searchChanged) {
            if (busy) pendingSearchSync = true;
            else syncAgent();
          }
          return settings;
        },
        // 用系统默认浏览器打开外部链接（设置-关于的跳转）
        openExternal(input: unknown) {
          const url = typeof input === "string" ? input.trim() : "";
          if (!/^https?:\/\//i.test(url)) throw new Error("仅支持 http(s) 链接");
          const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
          const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
          spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
          return { ok: true };
        },
        // ---------- 文件操作权限：按会话独立设置，改完即时重建 agent ----------
        setPermission(input: unknown) {
          if (busy) throw new Error("上一轮还在处理中");
          const level = typeof input === "string" ? input : "";
          if (!PERMISSION_LEVELS.includes(level as PermissionLevel)) {
            throw new Error("未知的权限级别");
          }
          permission = level as PermissionLevel;
          // 已落盘的会话同步元数据；未落盘（新会话）首条消息时随 touchSession 写入
          const meta = sessions.find((s) => s.id === threadId);
          if (meta) {
            meta.permission = permission;
            persistSessions(sessions);
          }
          syncAgent();
          return { permission };
        },
        // ---------- 工作区：get / 切换 / 新增 / 删除（均返回最新状态，前端据此重渲染下拉） ----------
        getWorkspaces(): WorkspacesState {
          return { activeId: workspaces.activeId, items: workspaces.items };
        },
        // 弹出系统目录选择器，返回选中的目录绝对路径；用户取消返回 null
        pickDirectory() {
          return showDirectoryPicker();
        },
        // 切换工作区：立即生效（重建 agent 绑定新目录的文件工具），会话不中断
        setWorkspace(input: unknown) {
          if (busy) throw new Error("上一轮还在处理中");
          const id = typeof input === "string" ? input : "";
          const target = workspaces.items.find((w) => w.id === id);
          if (!target) throw new Error("工作区不存在");
          if (id !== workspaces.activeId) {
            workspaces.activeId = id;
            saveWorkspaces(workspaces);
            if (config) {
              agent = createMinoAgent(config, target.path, permission, settings.search);
              agentPermission = permission;
              agentSearch = settings.search;
            }
          }
          return { activeId: workspaces.activeId, items: workspaces.items };
        },
        // 新增工作区（目录不存在时自动创建），并切换为活动工作区
        addWorkspace(input: unknown) {
          if (busy) throw new Error("上一轮还在处理中");
          const { name, dir } = normalizeWorkspaceInput(input);
          if (workspaces.items.some((w) => w.path === dir)) {
            throw new Error("该目录已是工作区");
          }
          // 目录不存在时递归创建；父目录无写权限时 mkdirSync 会抛 EACCES/EPERM
          try {
            fs.mkdirSync(dir, { recursive: true });
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "EACCES" || code === "EPERM") {
              throw new Error("目录创建失败：没有写入权限");
            }
            throw new Error(
              "目录创建失败：" + (err instanceof Error ? err.message : String(err))
            );
          }
          // 对已存在的目录也要校验可写，避免「能创建但后续文件读写失败」
          try {
            fs.accessSync(dir, fs.constants.W_OK);
          } catch {
            throw new Error("目录不可写：没有写入权限");
          }
          const item: WorkspaceMeta = { id: crypto.randomUUID(), name, path: dir };
          workspaces.items.push(item);
          workspaces.activeId = item.id;
          saveWorkspaces(workspaces);
          if (config) {
            agent = createMinoAgent(config, dir, permission, settings.search);
            agentPermission = permission;
            agentSearch = settings.search;
          }
          return { activeId: workspaces.activeId, items: workspaces.items };
        },
        // 删除工作区：仅从列表移除（不动磁盘目录）；删的是活动工作区时自动切到剩余的第一个
        deleteWorkspace(input: unknown) {
          if (busy) throw new Error("上一轮还在处理中");
          const id = typeof input === "string" ? input : "";
          const idx = workspaces.items.findIndex((w) => w.id === id);
          if (idx === -1) throw new Error("工作区不存在");
          if (workspaces.items.length <= 1) throw new Error("至少保留一个工作区");
          workspaces.items.splice(idx, 1);
          if (workspaces.activeId === id) {
            workspaces.activeId = workspaces.items[0].id;
            if (config) {
              agent = createMinoAgent(config, activeWorkspace().path, permission, settings.search);
              agentPermission = permission;
              agentSearch = settings.search;
            }
          }
          saveWorkspaces(workspaces);
          return { activeId: workspaces.activeId, items: workspaces.items };
        },
        // ---------- 工具面板：工作区文件浏览 + 面板宽度持久化 ----------
        listDir(rel: string) {
          return panelListDir(typeof rel === "string" ? rel : "");
        },
        readFile(rel: string) {
          return panelReadFile(typeof rel === "string" ? rel : "");
        },
        setPanelWidth(input: unknown) {
          const w =
            typeof input === "number" && Number.isFinite(input)
              ? Math.floor(input)
              : NaN;
          if (!(w >= 160 && w <= 2400)) throw new Error("面板宽度需在 160 到 2400 之间");
          settings = { ...settings, panelWidth: w };
          saveSettings(settings);
          return { panelWidth: w };
        },
        // ---------- 工具面板：内嵌终端 ----------
        termOpen(input: unknown) {
          const m =
            typeof input === "object" && input !== null
              ? (input as Record<string, unknown>)
              : {};
          const id = parseTermId(input);
          const cols =
            typeof m.cols === "number" && m.cols >= 20 && m.cols <= 400
              ? Math.floor(m.cols)
              : 80;
          const rows =
            typeof m.rows === "number" && m.rows >= 5 && m.rows <= 200
              ? Math.floor(m.rows)
              : 24;
          return termStart(id, cols, rows);
        },
        termWrite(input: unknown) {
          const m =
            typeof input === "object" && input !== null
              ? (input as Record<string, unknown>)
              : {};
          const id = parseTermId(input);
          const data = typeof m.data === "string" ? m.data : "";
          const s = termSessions.get(id);
          if (!s || s.child.killed) return { ok: false };
          try {
            s.child.stdin?.write(Buffer.from(data, "base64"));
            return { ok: true };
          } catch {
            return { ok: false };
          }
        },
        termKill(input: unknown) {
          termKill(parseTermId(input));
          return { ok: true };
        },
        async termResize(input: unknown) {
          const m =
            typeof input === "object" && input !== null
              ? (input as Record<string, unknown>)
              : {};
          const id = parseTermId(input);
          const cols =
            typeof m.cols === "number" && m.cols >= 20 && m.cols <= 400
              ? Math.floor(m.cols)
              : NaN;
          const rows =
            typeof m.rows === "number" && m.rows >= 5 && m.rows <= 200
              ? Math.floor(m.rows)
              : NaN;
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) return { ok: false };
          return termSyncSize(id, cols, rows);
        },
        async chat(message: string) {
          if (busy) throw new Error("上一轮还在处理中");
          if (!message || !message.trim()) throw new Error("消息不能为空");
          if (!agent) throw new Error("尚未配置模型，请先点击右上角「设置」");
          busy = true;
          try {
            touchSession(message.trim());
            // 一轮对话可能被多次权限确认打断：中断 → 等用户 decisions → Command 恢复，直到正常结束
            let input: RunChatStreamParams["input"] = {
              messages: [{ role: "user", content: message.trim() }],
            };
            for (;;) {
              const result = await runChatStream({ agent, input, push, threadId });
              if (result.status === "done") break;
              push({ type: "confirm_request", calls: result.calls });
              // 挂起等待前端确认；用户逐个允许 / 拒绝后由 resolveConfirm 唤醒
              const decisions = await new Promise<ConfirmDecision[]>((resolve) => {
                confirmResolver = resolve;
              });
              confirmResolver = null;
              input = new Command({ resume: { decisions } });
            }
            push({ type: "done" });
          } catch (err) {
            push({ type: "error", message: err instanceof Error ? err.message : String(err) });
          } finally {
            busy = false;
            confirmResolver = null;
            // 对话期间改过搜索设置 → 现在重建 agent 使其生效
            if (pendingSearchSync) {
              pendingSearchSync = false;
              syncAgent();
            }
          }
          // 返回当前会话 id，供前端把新会话标为「当前」并刷新侧栏
          return { sessionId: threadId };
        },
        // 用户在确认卡片上点完「允许 / 拒绝」后回传，唤醒挂起的对话
        resolveConfirm(input: unknown) {
          const resolve = confirmResolver;
          if (!resolve) throw new Error("当前没有等待确认的操作");
          const m =
            typeof input === "object" && input !== null
              ? (input as Record<string, unknown>)
              : {};
          const raw = Array.isArray(m.decisions) ? (m.decisions as unknown[]) : [];
          if (!raw.length) throw new Error("确认结果不能为空");
          const decisions = raw.map((d): ConfirmDecision => {
            const dm =
              typeof d === "object" && d !== null
                ? (d as Record<string, unknown>)
                : {};
            if (dm.type === "approve") return { type: "approve" };
            if (dm.type === "reject") {
              return {
                type: "reject",
                message: typeof dm.message === "string" && dm.message ? dm.message : "用户拒绝执行该操作",
              };
            }
            throw new Error("无效的确认结果");
          });
          confirmResolver = null;
          resolve(decisions);
          return { ok: true };
        },
        // 历史会话列表（按最近活跃倒序）
        async listSessions() {
          return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
        },
        // 开启新对话：换新线程，旧对话保留在历史列表；新会话回到默认权限
        async newSession() {
          if (busy) throw new Error("上一轮还在处理中");
          threadId = crypto.randomUUID();
          sessionSaved = false;
          permission = "workspace";
          syncAgent();
          return { permission };
        },
        // 打开历史会话：切换线程、恢复该会话的权限并回放全部消息（从 checkpointer 读取）
        async openSession(input: unknown) {
          if (busy) throw new Error("上一轮还在处理中");
          const id = typeof input === "string" ? input : "";
          const meta = sessions.find((s) => s.id === id);
          if (!meta) throw new Error("会话不存在");
          const messages = await readThreadMessages(id);
          threadId = id;
          sessionSaved = true;
          permission = meta.permission;
          syncAgent();
          return {
            id,
            title: meta.title,
            permission,
            items: historyToItems(messages),
          };
        },
        // 重命名会话：只改 sessions.json 元数据，不动消息本体
        async renameSession(input: unknown) {
          const m =
            typeof input === "object" && input !== null
              ? (input as Record<string, unknown>)
              : {};
          const id = typeof m.id === "string" ? m.id : "";
          const title = typeof m.title === "string" ? m.title.trim() : "";
          const meta = sessions.find((s) => s.id === id);
          if (!meta) throw new Error("会话不存在");
          if (!title) throw new Error("标题不能为空");
          meta.title = title.slice(0, 40);
          persistSessions(sessions);
          return { id: meta.id, title: meta.title };
        },
        // 删除会话：移除元数据并清理 checkpointer 里的消息本体
        async deleteSession(input: unknown) {
          if (busy) throw new Error("上一轮还在处理中");
          const id = typeof input === "string" ? input : "";
          const idx = sessions.findIndex((s) => s.id === id);
          if (idx === -1) return { cleared: false };
          sessions.splice(idx, 1);
          persistSessions(sessions);
          await checkpointer.deleteThread(id);
          if (threadId === id) {
            // 删除的是当前会话：换新线程，前端需清空消息区；回到默认权限
            threadId = crypto.randomUUID();
            sessionSaved = false;
            permission = "workspace";
            syncAgent();
            return { cleared: true };
          }
          return { cleared: false };
        },
      });
    });

    // 关闭窗口即退出
    win.on("close", () => process.exit(0));
    // app.run() 内部用 setInterval 泵原生事件，不阻塞 Node 事件循环
    app.run();
    console.log("已打开 Mino 窗口，关闭窗口即可退出");
  })().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`打开窗口失败: ${message.split("\n")[0]}`);
    process.exit(1);
  });
}
