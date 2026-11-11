import fs from "node:fs";
import path from "node:path";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { tool } from "langchain";
import { z } from "zod";
import type { PermissionLevel } from "./config.ts";

// ---------- 工具集：计算 / 文件操作（按工作区构建）/ 信息检索 ----------
// agent.ts 通过 `import { createTools } from "./tools.ts"` 装配；新增工具在本文件追加即可。
// 工具结果统一返回字符串（前端 web.ts 的 tool_result 渲染直接展示）。

// 默认直连；仅当用户在聊天内容里指定代理（模型将其作为 proxy 参数传入）时才走代理
function httpFetch(
  url: string,
  init: { headers?: Record<string, string>; redirect?: "follow" },
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

// 装配完整工具集：文件操作按权限模式管控
export function createTools(workspace: string) {
  return [
    calculator,
    getCurrentTime,
    ...createFileTools(workspace),
    searchWikiTool,
    searchBingTool,
    webFetchTool,
  ];
}

// ========== 信息检索类 ==========

// 工具 6：维基百科搜索（免 API Key）
const searchWikiTool = tool(
  async ({ query, lang = "zh", proxy }) => {
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json`;
    const res = await httpFetch(
      url,
      { headers: { "User-Agent": "MinoAgent/1.0 (local demo agent)" } },
      proxy,
      15000
    );
    if (!res.ok) return `搜索失败：HTTP ${res.status}`;
    const data = (await res.json()) as {
      query?: { search?: { title: string; snippet: string }[] };
    };
    const hits = data.query?.search ?? [];
    if (!hits.length) {
      return `没有找到与「${query}」相关的条目，可换个关键词或改用 lang="en" 重试。`;
    }
    return hits
      .map(
        (h) =>
          `【${h.title}】\n${h.snippet.replace(/<[^>]+>/g, "")}\nhttps://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title)}`
      )
      .join("\n\n");
  },
  {
    name: "search_wiki",
    description:
      "搜索维基百科条目，返回标题、摘要片段和链接，适合百科类知识检索（无需 API Key）。",
    schema: z.object({
      query: z.string().describe("搜索关键词"),
      lang: z.string().optional().describe("语言代码，默认 zh（中文），英文用 en"),
      proxy: z
        .string()
        .optional()
        .describe("可选，HTTP 代理地址（如 http://127.0.0.1:7890），仅在用户明确指定时填写"),
    }),
  }
);

// 工具 7：Bing 搜索（免 API Key，走 RSS 结果，便于稳定解析）
const searchBingTool = tool(
  async ({ query, count = 5, proxy }) => {
    const url =
      `https://www.bing.com/search?q=${encodeURIComponent(query)}` +
      `&count=${count}&format=rss`;
    const res = await httpFetch(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
      },
      proxy,
      15000
    );
    if (!res.ok) return `搜索失败：HTTP ${res.status}`;
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .map((m) => m[1])
      .slice(0, count);
    if (!items.length) {
      return `没有找到与「${query}」相关的结果，可换个关键词重试。`;
    }
    const decode = (s: string) =>
      s
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .trim();
    return items
      .map((block) => {
        const title = decode(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
        const link = decode(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "");
        const desc = decode(
          block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ""
        );
        return `【${title}】\n${desc}\n${link}`;
      })
      .join("\n\n");
  },
  {
    name: "search_bing",
    description:
      "通过 Bing 搜索网页，返回标题、摘要与链接，适合时事、新闻、通用网页检索（无需 API Key）。",
    schema: z.object({
      query: z.string().describe("搜索关键词"),
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("返回结果条数，默认 5"),
      proxy: z
        .string()
        .optional()
        .describe("可选，HTTP 代理地址（如 http://127.0.0.1:7890），仅在用户明确指定时填写"),
    }),
  }
);

// 工具 8：抓取网页正文
const webFetchTool = tool(
  async ({ url, proxy }) => {
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
      // HTML → 纯文本：去 script/style/textarea 与注释后剥标签、还原常见实体
      // （textarea 里常藏着页面备用 CSS/HTML，如百度首页的 s_index_off_css）
      const text = body
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<textarea[\s\S]*?<\/textarea>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n")
        .trim();
      return text.length > 5000
        ? text.slice(0, 5000) + `\n…（正文过长已截断，共 ${text.length} 字符）`
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
      proxy: z
        .string()
        .optional()
        .describe("可选，HTTP 代理地址（如 http://127.0.0.1:7890），仅在用户明确指定时填写"),
    }),
  }
);

