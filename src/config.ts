import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_ROOT =
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
export const CONFIG_DIR = path.join(CONFIG_ROOT, "Mino");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
// Agent 会话（checkpointer）的 SQLite 持久化文件
export const CHECKPOINT_DB = path.join(CONFIG_DIR, "checkpoints.sqlite");
// 会话历史列表（仅元数据：id 即 checkpointer 的 thread_id；消息本体在 CHECKPOINT_DB 里）
export const SESSIONS_FILE = path.join(CONFIG_DIR, "sessions.json");
// 工作区列表（元数据 + 当前选中项）；文件读写工具限制在工作区目录内
export const WORKSPACES_FILE = path.join(CONFIG_DIR, "workspaces.json");

// 应用级设置（代理 / 主题），独立于模型配置，未配置模型时也可保存
export const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.json");
// 默认工作区目录：用户目录下 ~/mino/default_workspace
export const DEFAULT_WORKSPACE_DIR = path.join(
  os.homedir(), "mino", "default_workspace"
);

// 单个工作区条目（type 而非 interface：可直接 JSON 序列化进 webview RPC）
export type WorkspaceMeta = {
  id: string;
  name: string;
  path: string;
};

export type WorkspacesState = {
  activeId: string;
  items: WorkspaceMeta[];
};

// 校验单条工作区记录的形状
function isWorkspaceMeta(value: unknown): value is WorkspaceMeta {
  if (typeof value !== "object" || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.id === "string" && w.id !== "" &&
    typeof w.name === "string" && w.name !== "" &&
    typeof w.path === "string" && w.path !== "" && path.isAbsolute(w.path)
  );
}

// 读取工作区列表；不存在 / 损坏 / 为空时初始化默认工作区
// 约束：至少保留一个工作区，activeId 必须指向列表内的条目
export function loadWorkspaces(): WorkspacesState {
  let items: WorkspaceMeta[] = [];
  let activeId = "";
  try {
    const data: unknown = JSON.parse(fs.readFileSync(WORKSPACES_FILE, "utf8"));
    if (typeof data === "object" && data !== null && Array.isArray((data as { items?: unknown }).items)) {
      items = ((data as { items: unknown[] }).items).filter(isWorkspaceMeta);
      const id = (data as { activeId?: unknown }).activeId;
      if (typeof id === "string") activeId = id;
    }
  } catch {
    // 文件不存在或损坏：从默认工作区开始
  }
  if (!items.length) {
    fs.mkdirSync(DEFAULT_WORKSPACE_DIR, { recursive: true });
    items = [{ id: "default", name: "默认工作区", path: DEFAULT_WORKSPACE_DIR }];
    activeId = "default";
    saveWorkspaces({ activeId, items });
  }
  if (!items.some((w) => w.id === activeId)) activeId = items[0].id;
  return { activeId, items };
}

export function saveWorkspaces(state: WorkspacesState): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(state, null, 2) + "\n");
}

// 模型目录条目，供网页设置页渲染
// （用 type 而非 interface：对象字面量类型带隐式索引签名，可直接 JSON 序列化进 webview RPC）
export type ProviderCatalogEntry = {
  id: string;
  label: string;
  models: string[];
};

// 模型目录，可按需扩展
export const MODEL_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "openai",
    label: "OpenAI",
    models: [
      "gpt-6", // 新一代主力模型
      "gpt-6-pro", // 最高级推理
      "gpt-5.6-sol", // 旗舰：复杂推理、编程、Agent
      "gpt-5.6-terra", // 性能与成本平衡
      "gpt-5.6-luna", // 低成本、高并发
      "gpt-4o-mini",
      "gpt-4o",
      "gpt-4.1",
      "gpt-4.1-mini",
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    models: ["deepseek-flash", "deepseek-v4-pro"],
  },
  {
    id: "zhipu",
    label: "智谱 (Zhipu)",
    models: [
      "glm-5.3", // 旗舰推理模型
      "glm-5.3-flash", // 高速模型
      "glm-5.3-flashx", // 极速模型
      "glm-5.2", // 推理模型
      "glm-5.1", // 推理模型
      "glm-5", // 旗舰模型
      "glm-5.2-fast-preview", // 高速预览版
    ],
  },
  {
    id: "moonshot",
    label: "Kimi (Moonshot)",
    models: [
      "kimi-k3.1-pro", // 旗舰推理
      "kimi-k3.1-pro-highspeed", // 高速推理
      "kimi-k3", // K3 基础旗舰
    ],
  },
  {
    id: "gemini",
    label: "Gemini (Google)",
    models: [
      "gemini-4-carbon", // 最强推理
      "gemini-4-argon", // 复杂 Agent / Coding
      "gemini-3.8-flash", // 普通 Agent
      "gemini-3.5-flash-lite", // 低成本批量调用
    ],
  },
  {
    id: "custom",
    label: "其他 OpenAI 兼容接口 (本地网关等)",
    models: [],
  },
];

// 已保存的 Agent 配置（custom 提供商必须带 baseUrl）
export interface AgentConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

// 可保存多份模型配置，activeId 指向当前生效的一份
export interface ModelProfile extends AgentConfig {
  id: string;
}

export interface ModelProfilesState {
  activeId: string;
  items: ModelProfile[];
}

function isAgentConfig(value: unknown): value is AgentConfig {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.provider === "string" &&
    c.provider !== "" &&
    typeof c.model === "string" &&
    c.model !== "" &&
    // API Key 允许为空：本地网关等无需鉴权的服务可以留空
    typeof c.apiKey === "string"
  );
}

function isModelProfile(value: unknown): value is ModelProfile {
  if (!isAgentConfig(value)) return false;
  const p = value as unknown as Record<string, unknown>;
  return typeof p.id === "string" && p.id !== "";
}

export function loadModelProfiles(): ModelProfilesState {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    // 旧版单配置 { provider, model, apiKey } 迁移为一条配置，保持用户现有模型可用
    if (isAgentConfig(data) && !isModelProfile(data)) {
      const item: ModelProfile = { id: crypto.randomUUID(), ...data };
      return { activeId: item.id, items: [item] };
    }
    if (typeof data === "object" && data !== null && Array.isArray((data as { items?: unknown }).items)) {
      const items = ((data as { items: unknown[] }).items).filter(isModelProfile);
      const id = (data as { activeId?: unknown }).activeId;
      const activeId =
        typeof id === "string" && items.some((m) => m.id === id) ? id : items[0]?.id ?? "";
      return { activeId, items };
    }
  } catch {
    // 配置不存在或损坏，走配置向导
  }
  return { activeId: "", items: [] };
}

export function saveModelProfiles(state: ModelProfilesState): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
  // 已存在文件的 mode 参数不生效，需显式收紧权限
  fs.chmodSync(CONFIG_FILE, 0o600);
}

export type Theme = "light" | "dark";

// 搜索设置：engines 为启用的引擎，数组顺序即调用优先级（靠前优先）
export const SEARCH_ENGINES = ["bing", "google", "bocha"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

// 搜索模式：
// - serial 接力：按优先级依次尝试，命中即止（少请求、低延迟，付费引擎只在前面都失败时才调用）
// - parallel 聚合：并行搜索全部启用引擎，结果合并去重后排序返回
export const SEARCH_MODES = ["serial", "parallel"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export type SearchSettings = {
  /** bing 国内可直连；google 需代理；bocha 国内可直连但需 API Key */
  engines: SearchEngine[];
  mode: SearchMode;
  bochaApiKey: string;
};

export const DEFAULT_SEARCH: SearchSettings = {
  engines: ["bing"],
  mode: "serial",
  bochaApiKey: "",
};

export function parseSearch(value: unknown): SearchSettings {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_SEARCH };
  const s = value as Record<string, unknown>;
  const apiKey =
    typeof s.bochaApiKey === "string" ? s.bochaApiKey.trim() : "";
  const mode = (SEARCH_MODES as readonly string[]).includes(s.mode as string)
    ? (s.mode as SearchMode)
    : "serial";
  if (Array.isArray(s.engines)) {
    // 过滤未知引擎（如已下线的 web/DuckDuckGo）并去重，保持用户给定的优先级顺序
    const engines = [
      ...new Set(
        s.engines.filter((e): e is SearchEngine =>
          (SEARCH_ENGINES as readonly string[]).includes(e as string)
        )
      ),
    ];
    return { engines, mode, bochaApiKey: apiKey };
  }
  // 旧格式迁移（{google, wiki, bocha} 布尔开关）：bing 默认启用，其余按旧开关追加
  const engines: SearchEngine[] = ["bing"];
  if (s.google === true) engines.push("google");
  if (s.bocha === true) engines.push("bocha");
  return { engines, mode, bochaApiKey: apiKey };
}

// 文件操作权限级别（读取一律免确认，仅写入受管控；按会话独立设置）：
// - readonly  仅可查看：所有写入都需要用户确认
// - workspace 工作区内修改（新会话默认）：工作区内自由读写，工作区外写入需确认
// - full      完全权限：任意路径读写均免确认
export type PermissionLevel = "readonly" | "workspace" | "full";

export const PERMISSION_LEVELS: PermissionLevel[] = ["readonly", "workspace", "full"];

export type ProxyProtocol = "http" | "socks5";

export type ProxyConfig = {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
};

export type AppSettings = {
  /** 代理配置，null 表示直连 */
  proxy: ProxyConfig | null;
  /** 界面主题 */
  theme: Theme;
  /** 工具面板宽度（像素），缺省用前端默认值 */
  panelWidth?: number;
  /** 正文字号（像素），12–20，缺省 15 */
  fontSize?: number;
  /** 搜索引擎开关（google / bocha），默认关闭；默认通用搜索无需开关 */
  search: SearchSettings;
};

const DEFAULT_SETTINGS: AppSettings = {
  proxy: null,
  theme: "light",
  search: { ...DEFAULT_SEARCH },
};

function parseProxy(value: unknown): ProxyConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  const host = typeof p.host === "string" ? p.host.trim() : "";
  const port =
    typeof p.port === "number" && Number.isInteger(p.port) ? p.port : NaN;
  if (!host || !(port > 0 && port < 65536)) return null;
  const protocol: ProxyProtocol = p.protocol === "socks5" ? "socks5" : "http";
  const username = typeof p.username === "string" ? p.username : "";
  const password = typeof p.password === "string" ? p.password : "";
  return { protocol, host, port, username, password };
}

export function loadSettings(): AppSettings {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (typeof data === "object" && data !== null) {
      const m = data as Record<string, unknown>;
      const pw =
        typeof m.panelWidth === "number" && Number.isFinite(m.panelWidth)
          ? Math.floor(m.panelWidth)
          : NaN;
      const fs_ =
        typeof m.fontSize === "number" && Number.isFinite(m.fontSize)
          ? Math.floor(m.fontSize)
          : NaN;
      return {
        proxy: parseProxy(m.proxy),
        theme: m.theme === "dark" ? "dark" : "light",
        panelWidth: pw >= 160 && pw <= 2400 ? pw : undefined,
        fontSize: fs_ >= 12 && fs_ <= 20 ? fs_ : undefined,
        search: parseSearch(m.search),
      };
    }
  } catch {
    // 文件不存在或损坏：使用默认值
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: AppSettings): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.chmodSync(SETTINGS_FILE, 0o600);
}
