import { createAgent, summarizationMiddleware, humanInTheLoopMiddleware, type InterruptOnConfig } from "langchain";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import fs from "node:fs";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatDeepSeek } from "@langchain/deepseek";
import { CHECKPOINT_DB, CONFIG_DIR, loadSettings, type AgentConfig, type PermissionLevel, type ProxyConfig, type SearchSettings } from "./config.ts";
import { createTools, needsConfirm, resolveWorkspacePath } from "./tools.ts";
import { startWebUI } from "./web.ts";
import {
  Agent as UndiciAgent,
  ProxyAgent,
  Socks5ProxyAgent,
  setGlobalDispatcher,
} from "undici";

// ---------- SQLite checkpointer：会话状态（含压缩结果）跨重启持久化 ----------
// 模块级单例：网页端改配置重建 agent 时复用同一个数据库连接
// 导出供 web 端读取历史消息与删除会话（deleteThread）
fs.mkdirSync(CONFIG_DIR, { recursive: true });
export const checkpointer = SqliteSaver.fromConnString(CHECKPOINT_DB);

// ---------- 全局代理：影响模型 API 与信息检索工具的 fetch ----------
// proxy 为 null 恢复直连；通过 undici 全局 dispatcher 让 Node 内置 fetch 也走代理
export function applyProxy(proxy: ProxyConfig | null): void {
  if (!proxy) {
    setGlobalDispatcher(new UndiciAgent());
    return;
  }
  if (proxy.protocol === "socks5") {
    setGlobalDispatcher(
      new Socks5ProxyAgent(`socks5://${proxy.host}:${proxy.port}`, {
        username: proxy.username || undefined,
        password: proxy.password || undefined,
      })
    );
    return;
  }
  // HTTP/HTTPS CONNECT 代理：认证内嵌到 URI 的 userinfo，undici 自动生成 Proxy-Authorization
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : "";
  setGlobalDispatcher(new ProxyAgent(`http://${auth}${proxy.host}:${proxy.port}`));
}

// ---------- 根据配置构建对应提供商的模型 ----------
// 各 SDK 在 Key 为空时会在构造阶段直接抛错，而本地网关通常不需要 Key；
// 用占位串兜底，真正无效时由服务端返回鉴权错误
export function buildModel(config: AgentConfig) {
  const apiKey = config.apiKey || "not-needed";
  switch (config.provider) {
    case "anthropic":
      return new ChatAnthropic({ model: config.model, apiKey });
    case "deepseek":
      return new ChatDeepSeek({ model: config.model, apiKey });
    case "zhipu":
      // 智谱开放平台的 OpenAI 兼容接口，固定 baseURL，无需用户填写
      return new ChatOpenAI({
        model: config.model,
        apiKey,
        configuration: { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
      });
    case "moonshot":
      // Kimi 的 OpenAI 兼容接口
      return new ChatOpenAI({
        model: config.model,
        apiKey,
        configuration: { baseURL: "https://api.moonshot.cn/v1" },
      });
    case "gemini":
      // Gemini 的 OpenAI 兼容端点，避免额外引入 Google SDK
      return new ChatOpenAI({
        model: config.model,
        apiKey,
        configuration: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" },
      });
    case "openai":
      return new ChatOpenAI({ model: config.model, apiKey });
    default:
      // 其他 OpenAI 兼容接口（本地网关等）
      return new ChatOpenAI({
        model: config.model,
        apiKey,
        configuration: { baseURL: config.baseUrl },
      });
  }
}

// ---------- 根据配置构建 Agent（网页端修改配置 / 切换工作区后可重建） ----------
export type MinoAgent = ReturnType<typeof createMinoAgent>;

// 各权限级别的系统提示词说明（读取一律免确认，仅写入受权限管控）
const PERMISSION_PROMPTS: Record<PermissionLevel, string> = {
  readonly:
    "当前文件权限为「仅可查看」：读取任意路径的文件无需确认；所有写入操作都会先请用户确认，被拒绝的操作不会执行。",
  workspace:
    "当前文件权限为「工作区内修改」：工作区内文件可自由读写；工作区外的写入会先请用户确认，被拒绝的操作不会执行。",
  full: "当前文件权限为「完全权限」：可以读写计算机上任意路径的文件，无需用户确认。",
};

// 受权限管控的文件工具：读取（含工作区外）免确认，仅写入需按权限级别拦截
const GATED_FILE_TOOLS: Array<{ name: string; verb: string }> = [
  { name: "write_file", verb: "写入文件" },
];

// 按权限级别构建需要用户确认的工具拦截配置（humanInTheLoopMiddleware）
function buildInterruptOn(workspaceDir: string, permission: PermissionLevel): Record<string, InterruptOnConfig> {
  const interruptOn: Record<string, InterruptOnConfig> = {};
  for (const { name, verb } of GATED_FILE_TOOLS) {
    interruptOn[name] = {
      allowedDecisions: ["approve", "reject"],
      when: (request) => {
        const raw = request.toolCall.args.path;
        if (typeof raw !== "string" || !raw) return false; // 无路径参数 → 工具自身会报错，不拦截
        const { inside } = resolveWorkspacePath(workspaceDir, raw);
        return needsConfirm(permission, "write", inside);
      },
      description: (toolCall) => {
        const raw = toolCall.args.path;
        const { inside } = resolveWorkspacePath(workspaceDir, typeof raw === "string" && raw ? raw : ".");
        const scope = inside ? "工作区内" : "工作区外";
        const note = inside && permission === "readonly" ? "（当前为「仅可查看」模式，写入需确认）" : "";
        return `${verb}｜${scope}：${typeof raw === "string" && raw ? raw : "(未指定路径)"}${note}`;
      },
    };
  }
  return interruptOn;
}

export function createMinoAgent(config: AgentConfig, workspaceDir: string, permission: PermissionLevel, search: SearchSettings) {
  return createAgent({
    model: buildModel(config),
    // 计算器 / 时间 / 文件操作与搜索（写入按权限模式管控）/ 信息检索（Bocha 开关与模型商搜索），定义见 src/tools.ts
    tools: createTools(workspaceDir, search, config),
    systemPrompt:
      "你是一个乐于助人的中文助手。可使用提供的工具（计算、获取时间、文件读写、文件搜索、信息检索）完成任务和回答问题。" +
      "按文件名或路径模式找文件用 glob_search，在文件内容里找文本用 grep_search，找到路径后再用 read_file 读取；" +
      "信息检索时调用一次 web_search 通常已足够，不要对同一问题反复搜索；需要正文时再用 web_fetch 读取具体链接。" +
      `当前工作区目录为 ${workspaceDir}，相对路径以工作区为基准；` +
      `${PERMISSION_PROMPTS[permission]}涉及文件操作时先确认路径与内容再写入。`,
    // 会话状态（含压缩结果）挂在 SQLite checkpointer 的 thread_id 上，调用方只需传新消息
    checkpointer,
    // 上下文自动压缩：token 估算超阈值时，把旧消息让模型总结成一条摘要，保留最近几轮
    // trigger 不配置则永不触发；分数阈值（fraction）需要模型 profile，自定义 baseUrl 接口用绝对 tokens 更稳
    middleware: [
      summarizationMiddleware({
        model: buildModel(config), // 做摘要的模型，可换成更便宜的
        trigger: { tokens: 16000 },
        keep: { messages: 20 },
      }),
      // 文件操作权限确认：按权限级别 + 路径位置拦截工具调用，等待网页端用户「允许 / 拒绝」
      // batched 模式：每轮模型输出里所有需确认的调用合并为一个中断，一次性回传 decisions
      humanInTheLoopMiddleware({
        interruptMode: "batched",
        interruptOn: buildInterruptOn(workspaceDir, permission),
      }),
    ],
  });
}

// ---------- 入口 ----------
async function main(): Promise<void> {
  applyProxy(loadSettings().proxy);
  // 启动原生窗口对话（Linux: WebKitGTK / Windows: WebView2 / macOS: WKWebView）
  // 配置的查看与修改均通过窗口内「模型设置」完成
  startWebUI();
}

main().catch((err) => {
  if (err.message?.includes("User force closed")) {
    console.log("\n已取消");
    process.exit(0);
  }
  console.error("运行失败:", err.message);
  process.exit(1);
});
