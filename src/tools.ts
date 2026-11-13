import fs from "node:fs";
import path from "node:path";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import * as cheerio from "cheerio";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { tool } from "langchain";
import { z } from "zod";
import type {
  AgentConfig,
  PermissionLevel,
  SearchSettings,
} from "./config.ts";

// ---------- 工具集：计算 / 文件操作（按工作区构建）/ 信息检索 ----------
// agent.ts 通过 `import { createTools } from "./tools.ts"` 装配；新增工具在本文件追加即可。
// 工具结果统一返回字符串（前端 web.ts 的 tool_result 渲染直接展示）。

// 默认直连；仅当用户在聊天内容里指定代理（模型将其作为 proxy 参数传入）时才走代理
function httpFetch(
  url: string,
  init: {
    headers?: Record<string, string>;
    redirect?: "follow";
    method?: string;
    body?: string;
  },
  proxy?: string,
  timeoutMs = 20000
) {
  const opts = { ...init, signal: AbortSignal.timeout(timeoutMs) };
  return proxy
    ? undiciFetch(url, { ...opts, dispatcher: new ProxyAgent(proxy) })
    : fetch(url, opts);
}

// ========== 基础：计算器 / 当前时间 ==========

// 工具 1：计算器
const calculator = tool(
  async ({ expression }) => {
    // 注意：Function 构造器仅用于演示，生产环境请使用安全的数学库
    const result = Function(`"use strict"; return (${expression})`)();
    return `计算结果为 ${result}`;
  },
  {
    name: "calculator",
    description: "计算数学表达式。输入如 '(2 + 3) * 4'。",
    schema: z.object({
      expression: z.string().describe("要计算的数学表达式"),
    }),
  }
);

// 工具 2：获取当前时间
const getCurrentTime = tool(
  async () => new Date().toLocaleString("zh-CN", { hour12: false }),
  {
    name: "get_current_time",
    description: "获取当前日期和时间。",
    schema: z.object({}),
  }
);

// ========== 文件操作类（按权限模式管控） ==========
// 相对路径以工作区为基准解析；工具本身可访问任意绝对路径，
// 是否需要用户确认由 agent.ts 的 humanInTheLoopMiddleware 按权限级别拦截。
export function resolveWorkspacePath(
  workspace: string,
  input: string
): { path: string; inside: boolean } {
  const abs = path.resolve(workspace, input || ".");
  const inside = abs === workspace || abs.startsWith(workspace + path.sep);
  return { path: abs, inside };
}

// 权限策略：某操作在该权限级别下是否需要用户确认
// - readonly：任何写入（无论工作区内外）→ 确认
// - workspace：工作区外写入 → 确认
// - full：全部免确认
// 读取（含工作区外）一律免确认
export function needsConfirm(
  permission: PermissionLevel,
  op: "read" | "write",
  inside: boolean
): boolean {
  if (op === "read") return false;
  if (permission === "full") return false;
  if (inside) return permission === "readonly";
  return true;
}

// 工厂：文件工具按工作区目录构建（切换工作区时由 web.ts 重建 agent 重新装配）
function createFileTools(workspace: string) {
  // 工具：读文件
  const readFileTool = tool(
    async ({ path: file }) => {
      try {
        const target = resolveWorkspacePath(workspace, file).path;
        const content = fs.readFileSync(target, "utf-8");
        return content.length > 20000
          ? content.slice(0, 20000) + `\n…（内容过长已截断，全文共 ${content.length} 字符）`
          : content || "(空文件)";
      } catch (err) {
        return `读取失败：${(err as Error).message}`;
      }
    },
    {
      name: "read_file",
      description:
        "读取指定路径文本文件（UTF-8）的内容，超长内容自动截断。相对路径以当前工作区为基准，也可用绝对路径读取工作区外的文件。",
      schema: z.object({
        path: z.string().describe("文件路径，相对当前工作区或绝对路径"),
      }),
    }
  );

  // 工具：写文件
  const writeFileTool = tool(
    async ({ path: file, content }) => {
      try {
        const target = resolveWorkspacePath(workspace, file).path;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, "utf-8");
        return `已写入 ${target}（${content.length} 字符）`;
      } catch (err) {
        return `写入失败：${(err as Error).message}`;
      }
    },
    {
      name: "write_file",
      description:
        "把内容写入指定路径的文本文件（覆盖已有内容）；父目录不存在时自动创建。相对路径以当前工作区为基准，绝对路径可指向工作区外（工作区外写入可能需要用户确认）。",
      schema: z.object({
        path: z.string().describe("文件路径，相对当前工作区或绝对路径"),
        content: z.string().describe("要写入的完整内容"),
      }),
    }
  );

  // 工具：列目录
  const listDirectoryTool = tool(
    async ({ path: dir = "." }) => {
      try {
        const target = resolveWorkspacePath(workspace, dir).path;
        const entries = fs.readdirSync(target, { withFileTypes: true });
        if (!entries.length) return "(空目录)";
        return entries
          .map((e) => {
            const type = e.isDirectory() ? "目录" : e.isFile() ? "文件" : "其他";
            let suffix = "";
            if (e.isFile()) {
              try {
                suffix = `，${fs.statSync(path.join(target, e.name)).size} 字节`;
              } catch {
                /* 文件刚被删除等场景忽略 */
              }
            }
            return `- ${e.name}（${type}${suffix}）`;
          })
          .join("\n");
      } catch (err) {
        return `列目录失败：${(err as Error).message}`;
      }
    },
    {
      name: "list_directory",
      description:
        "列出指定目录下的文件与子目录（名称、类型、大小），不递归进入子目录。相对路径以当前工作区为基准，也可用绝对路径列出工作区外的目录。",
      schema: z.object({
        path: z.string().optional().describe("目录路径，默认当前工作区根目录"),
      }),
    }
  );

  return [readFileTool, writeFileTool, listDirectoryTool];
}

// 装配完整工具集：文件操作按权限模式管控；搜索引擎按设置开关装配进 web_search。
// 需要激活模型的配置（模型商搜索复用它的 API Key / Base URL），agent 重建时随之更新
export function createTools(
  workspace: string,
  search: SearchSettings,
  config: AgentConfig
) {
  return [
    calculator,
    getCurrentTime,
    ...createFileTools(workspace),
    createWebSearchTool(search, config),
    webFetchTool,
  ];
}

// ========== 信息检索类 ==========

// 单条搜索结果（各引擎统一的结构化返回，便于在工具层合并 / 去重 / 排序）
interface SearchHit {
  title: string;
  desc: string;
  url: string;
}

// 模型商搜索接口：复用当前激活模型的 API Key 直接调用其搜索能力。
// 智谱（web_search）与 DeepSeek（/v1/tools/search）提供独立搜索端点；
// OpenAI 无独立端点，经 Responses API 挂内置 web_search 工具让模型边搜边答，
// 再从回答的 url_citation 注解里提取来源，适配成统一的 SearchHit
async function searchProvider(
  query: string,
  limit: number,
  config: AgentConfig,
  proxy?: string
): Promise<SearchHit[]> {
  if (!config.apiKey) throw new Error("当前模型未配置 API Key");
  if (config.provider === "deepseek") {
    // 用户填的 Base URL 可能带 /v1（OpenAI 兼容习惯），剥掉后统一拼端点
    const base = (config.baseUrl || "https://api.deepseek.com")
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");
    const res = await httpFetch(
      `${base}/v1/tools/search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ query, count: limit }),
      },
      proxy,
      15000
    );
    if (!res.ok)
      throw new Error(
        res.status === 401 ? "HTTP 401（API Key 无效）" : `HTTP ${res.status}`
      );
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; summary?: string }>;
    };
    return (data.results ?? [])
      .map((h) => ({
        title: h.title ?? "",
        // DeepSeek 的 summary 很长，保留 1000 字符，其余截断避免撑爆上下文
        desc: (h.summary ?? "").slice(0, 1000),
        url: h.url ?? "",
      }))
      .filter((h) => h.title || h.url);
  }
  if (config.provider === "openai") {
    const base = (config.baseUrl || "https://api.openai.com/v1").replace(
      /\/+$/,
      ""
    );
    const res = await httpFetch(
      `${base}/responses`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          tools: [{ type: "web_search" }],
          input: query,
        }),
      },
      proxy,
      60000 // 模型带搜索的完整推理，耗时远超普通搜索接口
    );
    if (!res.ok) {
      // 模型不支持 web_search 等错误以 400 返回，带上服务端信息便于诊断
      let detail = "";
      try {
        detail =
          ((await res.json()) as { error?: { message?: string } }).error
            ?.message ?? "";
      } catch {
        /* 响应体不是 JSON 时忽略 */
      }
      throw new Error(
        res.status === 401
          ? "HTTP 401（API Key 无效）"
          : `HTTP ${res.status}${detail ? `（${detail}）` : ""}`
      );
    }
    const data = (await res.json()) as {
      output?: Array<{
        type?: string;
        content?: Array<{
          type?: string;
          text?: string;
          annotations?: Array<{
            type?: string;
            title?: string;
            url?: string;
          }>;
        }>;
      }>;
    };
    let text = "";
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const item of data.output ?? []) {
      if (item.type !== "message") continue;
      for (const block of item.content ?? []) {
        if (block.type === "output_text" && block.text) text += block.text;
        for (const a of block.annotations ?? []) {
          if (a.type !== "url_citation" || !a.url || seen.has(a.url)) continue;
          seen.add(a.url);
          hits.push({ title: a.title ?? a.url, desc: "", url: a.url });
        }
      }
    }
    // 引用来源在前，模型生成的搜索综述殿后（同样截断 1000 字符）
    if (text || hits.length)
      hits.push({ title: "搜索结果综述", desc: text.slice(0, 1000), url: "" });
    return hits;
  }
  if (config.provider !== "zhipu")
    throw new Error(
      "当前模型商未提供搜索接口（目前智谱、DeepSeek、OpenAI 支持）"
    );
  // 智谱 OpenAI 兼容端点为 /api/paas/v4（chat/completions 挂在其下），web_search 同级
  const base = (
    config.baseUrl || "https://open.bigmodel.cn/api/paas/v4"
  ).replace(/\/+$/, "");
  const res = await httpFetch(
    `${base}/web_search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        search_engine: "search_std",
        search_query: query,
        count: limit,
        search_recency_filter: "noLimit",
      }),
    },
    proxy,
    15000
  );
  if (!res.ok)
    throw new Error(
      res.status === 401 ? "HTTP 401（API Key 无效）" : `HTTP ${res.status}`
    );
  const data = (await res.json()) as {
    response?: Array<{
      name?: string;
      url?: string;
      snippet?: string;
      snippet_content?: string;
    }>;
  };
  return (data.response ?? [])
    .map((h) => ({
      title: h.name ?? "",
      desc: h.snippet_content || h.snippet || "",
      url: h.url ?? "",
    }))
    .filter((h) => h.title || h.url);
}

// Bocha 搜索核心逻辑（付费 API，Key 由用户在设置中填写；国内可直连）
async function searchBocha(
  query: string,
  limit: number,
  apiKey: string,
  proxy?: string
): Promise<SearchHit[]> {
  const res = await httpFetch(
    "https://api.bochaai.com/v1/web-search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, count: limit, summary: true, freshness: "noLimit" }),
    },
    proxy,
    15000
  );
  if (!res.ok)
    throw new Error(
      res.status === 401
        ? "HTTP 401（博查 API Key 无效，请在设置中检查）"
        : `HTTP ${res.status}`
    );
  const data = (await res.json()) as {
    data?: {
      webPages?: {
        value?: Array<{
          name?: string;
          url?: string;
          snippet?: string;
          summary?: string;
        }>;
      };
    };
  };
  return (data.data?.webPages?.value ?? [])
    .map((h) => ({
      title: h.name ?? "",
      desc: h.summary || h.snippet || "",
      url: h.url ?? "",
    }))
    .filter((h) => h.title || h.url);
}

// SerpAPI 搜索核心逻辑（付费 API，国内通常需代理）：固定先 google 再 brave 级联，
// google 用 gl/hl 固定中国区中文（实测对中文查询质量最好），失败或无结果自动换 brave
async function searchSerpapi(
  query: string,
  limit: number,
  apiKey: string,
  proxy?: string
): Promise<SearchHit[]> {
  const engines = [
    { name: "google", extra: { gl: "cn", hl: "zh-cn" } },
    { name: "brave", extra: {} },
  ] as const;
  const errors: string[] = [];
  for (const { name, extra } of engines) {
    const params = new URLSearchParams({
      engine: name,
      q: query,
      num: String(limit),
      ...extra,
      api_key: apiKey,
    });
    try {
      const res = await httpFetch(
        `https://serpapi.com/search.json?${params}`,
        { method: "GET" },
        proxy,
        20000
      );
      if (!res.ok)
        throw new Error(
          res.status === 401
            ? "HTTP 401（SerpAPI API Key 无效，请在设置中检查）"
            : `HTTP ${res.status}`
        );
      const data = (await res.json()) as {
        organic_results?: Array<{
          title?: string;
          link?: string;
          snippet?: string;
        }>;
        // SerpAPI 用 HTTP 200 + error 字段表达业务失败（如引擎对部分查询不给结果）
        error?: string;
      };
      if (data.error && !data.organic_results?.length)
        throw new Error(data.error);
      const hits = (data.organic_results ?? [])
        .map((h) => ({
          title: h.title ?? "",
          desc: h.snippet ?? "",
          url: h.link ?? "",
        }))
        .filter((h) => h.title || h.url);
      if (hits.length) return hits;
      errors.push(`${name}: 没有找到相关结果`);
    } catch (err) {
      const msg = (err as Error).message;
      // Key 无效属致命错误，换引擎也救不了，直接抛出终止级联
      if (msg.includes("401")) throw new Error(msg);
      errors.push(`${name}: ${msg}`);
    }
  }
  throw new Error(errors.join("；"));
}

// 工厂：统一搜索入口。默认用当前模型商的搜索接口（复用其 API Key）；
// 用户启用付费引擎（博查 / SerpAPI）后按卡片顺序依次尝试，失败或无结果时自动回落模型商搜索。
// 不给模型暴露引擎参数：调用方式由用户设置决定，避免模型乱传值触发校验失败与重试
function createWebSearchTool(search: SearchSettings, config: AgentConfig) {
  // 按用户拖定的卡片顺序构建尝试队列：第一个优先，失败尝试下一个启用的引擎
  const paidEngines: Array<{
    name: string;
    run: (query: string, limit: number, proxy?: string) => Promise<SearchHit[]>;
  }> = [];
  for (const id of search.engineOrder) {
    if (id === "bocha" && search.bocha && search.bochaApiKey)
      paidEngines.push({
        name: "博查",
        run: (q, n, p) => searchBocha(q, n, search.bochaApiKey, p),
      });
    else if (id === "serpapi" && search.serpapi && search.serpapiApiKey)
      paidEngines.push({
        name: "SerpAPI",
        run: (q, n, p) => searchSerpapi(q, n, search.serpapiApiKey, p),
      });
  }
  const providerReady =
    (config.provider === "zhipu" ||
      config.provider === "deepseek" ||
      config.provider === "openai") &&
    !!config.apiKey;
  const formatHits = (hits: SearchHit[]) =>
    hits.map((h) => `【${h.title}】\n${h.desc}\n${h.url}`).join("\n\n");
  const desc = paidEngines.length
    ? "搜索互联网信息。优先使用已启用的付费搜索引擎，失败时自动回落模型商搜索接口。一次调用通常已包含足够信息，不需要对同一问题反复搜索。"
    : providerReady
      ? "搜索互联网信息（当前模型商的搜索接口）。一次调用通常已包含足够信息，不需要对同一问题反复搜索。"
      : "搜索互联网信息。（当前模型商未提供搜索接口，可在设置中启用博查或 SerpAPI 搜索。）";
  return tool(
    async ({ query, limit, proxy }) => {
      // 参数一律在运行时归一化：模型传 null / 越界值时给出合理默认，而不是抛 schema 错误
      const count =
        Number.isInteger(limit) && limit! >= 1 && limit! <= 10 ? limit! : 5;
      const via = proxy ?? undefined;
      // 已启用的付费引擎按序尝试，任一成功即返回；全部失败再回落模型商搜索，两边都败才报错
      if (paidEngines.length) {
        const failures: string[] = [];
        for (const engine of paidEngines) {
          try {
            const hits = await engine.run(query, count, via);
            if (hits.length) {
              const note = failures.length
                ? `搜索引擎：${engine.name}\n（${failures.join("；")}；已切换）\n\n`
                : `搜索引擎：${engine.name}\n\n`;
              return `${note}${formatHits(hits)}`;
            }
            failures.push(`${engine.name}：没有找到相关结果`);
          } catch (err) {
            failures.push(`${engine.name}：${(err as Error).message}`);
          }
        }
        let providerError = "";
        try {
          const hits = await searchProvider(query, count, config, via);
          if (hits.length)
            return `搜索引擎：模型商搜索\n（${failures.join("；")}；已回落模型商搜索）\n\n${formatHits(hits)}`;
          providerError = "没有找到相关结果";
        } catch (err) {
          providerError = (err as Error).message;
        }
        return `付费引擎与模型商搜索均未返回结果，可稍后重试或换个关键词。\n${failures.join("\n")}\n模型商搜索：${providerError}`;
      }
      try {
        const hits = await searchProvider(query, count, config, via);
        if (hits.length) return `搜索引擎：模型商搜索\n\n${formatHits(hits)}`;
        return "没有找到相关结果，可换个关键词重试。";
      } catch (err) {
        return `搜索失败：${(err as Error).message}。可在设置中启用博查或 SerpAPI 搜索。`;
      }
    },
    {
      name: "web_search",
      description: desc,
      schema: z.object({
        query: z.string().describe("搜索关键词"),
        limit: z
          .number()
          .nullish()
          .describe("返回结果条数，1–10，默认 5"),
        proxy: z
          .string()
          .nullish()
          .describe("可选，HTTP 代理地址（如 http://127.0.0.1:7890），仅在用户明确指定时填写"),
      }),
    }
  );
}

// 工具 8：抓取网页正文
const webFetchTool = tool(
  async ({ url, maxLength, proxy }) => {
    // 运行时归一化（同 web_search 的 limit）：模型传 null / 越界值时给合理默认，不抛 schema 错误
    const cap =
      Number.isInteger(maxLength) && maxLength! >= 100 && maxLength! <= 50000
        ? maxLength!
        : 8000;
    try {
      const res = await httpFetch(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            Accept: "text/html,application/json,text/plain,*/*",
          },
          redirect: "follow",
        },
        proxy
      );
      if (!res.ok) return `请求失败：HTTP ${res.status}`;
      const type = res.headers.get("content-type") ?? "";
      if (!/text|html|json|xml/i.test(type)) {
        return `非文本内容（${type}，${res.headers.get("content-length") ?? "?"} 字节），无法读取。`;
      }

      const body = await res.text();
      let text: string;
      const isHtml =
        /html/i.test(type) ||
        /^\s*<(?:!doctype|html|head|body|main|article|div|p)\b/i.test(body);

      if (isHtml) {
        const dom = new JSDOM(body, {
          url,
          virtualConsole: new VirtualConsole(),
        });
        const article = new Readability(dom.window.document).parse();
        // 优先使用 Readability 提取的正文
        const html = article?.content ?? body;
        const $ = cheerio.load(html);

        // Readability 成功时尽量少清理，失败时清理整页噪声
        if (!article) {
          $("script, style, textarea, noscript, iframe, svg, nav, header, footer, aside").remove();
        } else {
          $("script, style, noscript, iframe, svg").remove();
        }

        // 保留基本段落结构
        $("br").replaceWith("\n");
        $("p, div, section, article, h1, h2, h3, h4, li, blockquote, tr")
          .append("\n");

        text = $.root().text();

        if (article?.title) {
          text = `${article.title}\n\n${text}`;
        }

        text = text
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t]+/g, " ")
          .replace(/\n[ \t]+/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      } else {
        // JSON / 纯文本原样保留
        text = body;
      }
      return text.length > cap
        ? text.slice(0, cap) + `\n…（正文过长已截断，共 ${text.length} 字符）`
        : text || "(空内容)";
    } catch (err) {
      return `抓取失败：${(err as Error).message}`;
    }
  },
  {
    name: "web_fetch",
    description:
      "抓取指定网址的正文文本（网页 / JSON / 纯文本），HTML 标签会被清理，超长自动截断。",
    schema: z.object({
      url: z.string().describe("完整网址，必须以 http:// 或 https:// 开头"),
      maxLength: z
        .number()
        .nullish()
        .describe("返回正文的最大字符数，100–50000，默认 8000"),
      proxy: z
        .string()
        .optional()
        .describe("可选，HTTP 代理地址（如 http://127.0.0.1:7890），仅在用户明确指定时填写"),
    }),
  }
);

