import fs from "node:fs";
import path from "node:path";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import * as cheerio from "cheerio";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { tool } from "langchain";
import { z } from "zod";
import type { PermissionLevel, SearchSettings } from "./config.ts";

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

// 装配完整工具集：文件操作按权限模式管控；搜索引擎按设置开关装配进 web_search
export function createTools(workspace: string, search: SearchSettings) {
  return [
    calculator,
    getCurrentTime,
    ...createFileTools(workspace),
    createWebSearchTool(search),
    webFetchTool,
  ];
}

// ========== 信息检索类 ==========

// 标签与 HTML 实体清理（Bing RSS 解析用）
const decodeEntities = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();

// 单条搜索结果（各引擎统一的结构化返回，便于在工具层合并 / 去重 / 排序）
interface SearchHit {
  title: string;
  desc: string;
  url: string;
}

// Bing 搜索核心逻辑（免 API Key，走 RSS 结果，便于稳定解析），默认引擎
// 注意：Bing 免费端点对「人名 + 主题词」类多词中文查询有时会分词失效（返回无关结果），
// 此时可开启 google / bocha 引擎作为更高优先级的补充
async function searchBing(
  query: string,
  limit: number,
  proxy?: string
): Promise<SearchHit[]> {
  const url =
    `https://www.bing.com/search?q=${encodeURIComponent(query)}` +
    `&count=${limit}&format=rss`;
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => m[1])
    .slice(0, limit)
    .map((block) => {
      const title = decodeEntities(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
      const link = decodeEntities(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "");
      const desc = decodeEntities(
        block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ""
      );
      return { title, desc, url: link };
    })
    .filter((h) => h.title || h.url);
}

// Google 搜索核心逻辑（免 API Key）：普通 HTML 搜索有反爬拦截，走 News RSS 才能稳定拿到结构化结果
async function searchGoogle(
  query: string,
  limit: number,
  proxy?: string
): Promise<SearchHit[]> {
  // 按查询语言切换地区参数，中文结果质量更好
  const cjk = /[\u4e00-\u9fff]/.test(query);
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
    (cjk ? `&hl=zh-CN&gl=CN&ceid=CN:zh-Hans` : `&hl=en-US&gl=US&ceid=US:en`);
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => m[1])
    .slice(0, limit)
    .map((block) => {
      const title = decodeEntities(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
      const link = decodeEntities(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "");
      const source = decodeEntities(
        block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? ""
      );
      const pubDate = decodeEntities(
        block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? ""
      );
      return {
        title,
        desc: [source, pubDate].filter(Boolean).join(" · "),
        url: link,
      };
    })
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
        ? "HTTP 401（Bocha API Key 无效，请在设置中检查）"
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

const ENGINE_LABELS: Record<string, string> = {
  bing: "Bing",
  google: "Google",
  bocha: "Bocha",
};

// 工厂：统一搜索入口，引擎优先级与搜索模式都来自设置
// - serial 接力：按优先级依次尝试，某引擎报错 / 无结果时自动切到下一个
// - parallel 聚合：并行搜索全部启用引擎，结果合并去重排序后返回
// 不给模型暴露引擎参数：调用方式由用户设置决定，避免模型乱传值触发校验失败与重试
function createWebSearchTool(search: SearchSettings) {
  // bocha 需要用户填 Key；没填时不作为可用引擎，避免必然 401 的调用
  const enabled = search.engines.filter(
    (e) => e !== "bocha" || !!search.bochaApiKey
  );
  const runners: Record<
    string,
    (query: string, limit: number, proxy?: string) => Promise<SearchHit[]>
  > = {
    bing: searchBing,
    google: searchGoogle,
    bocha: (q, n, p) => searchBocha(q, n, search.bochaApiKey, p),
  };
  // 单引擎调用不抛异常：失败转为 { error }，由级联 / 合并逻辑消化
  const tryEngine = async (
    e: string,
    q: string,
    n: number,
    p?: string
  ): Promise<{ hits: SearchHit[]; error?: string }> => {
    try {
      return { hits: await runners[e](q, n, p) };
    } catch (err) {
      return { hits: [], error: (err as Error).message };
    }
  };
  // URL 归一化（去锚点与尾斜杠）作为跨引擎去重键，无 URL 时退化为标题去重
  const normalizeUrl = (u: string) => u.replace(/#.*$/, "").replace(/\/+$/, "");
  // 合并去重排序：按各引擎内部名次轮转交错（优先级高的引擎每轮靠前），
  // 同一 URL 只保留各引擎中更靠前的那条
  const mergeHits = (groups: { engine: string; hits: SearchHit[] }[]) => {
    const seen = new Set<string>();
    const merged: { engine: string; hit: SearchHit }[] = [];
    const maxLen = Math.max(0, ...groups.map((g) => g.hits.length));
    for (let i = 0; i < maxLen; i++) {
      for (const g of groups) {
        const hit = g.hits[i];
        if (!hit) continue;
        const key = normalizeUrl(hit.url) || hit.title;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push({ engine: g.engine, hit });
      }
    }
    return merged;
  };
  const formatHits = (merged: { engine: string; hit: SearchHit }[]) =>
    merged
      .map(
        ({ engine, hit }) =>
          `【${hit.title}】（${ENGINE_LABELS[engine]}）\n${hit.desc}\n${hit.url}`
      )
      .join("\n\n");
  const cascade = async (chain: string[], q: string, n: number, p?: string) => {
    if (!chain.length)
      return "没有可用的搜索引擎，请在设置的「搜索」页签中开启。";
    const errors: string[] = [];
    for (const e of chain) {
      const { hits, error } = await tryEngine(e, q, n, p);
      if (hits.length) return formatHits(mergeHits([{ engine: e, hits }]));
      errors.push(`${ENGINE_LABELS[e]}：${error || "没有找到相关结果"}`);
    }
    return `所有引擎均未能返回结果，可稍后重试或换个关键词。\n${errors.join("\n")}`;
  };
  const desc =
    enabled.length
      ? `搜索互联网信息。已启用引擎（按优先级）：${enabled.map((e) => ENGINE_LABELS[e]).join("、")}。` +
        (search.mode === "parallel"
          ? `当前为聚合模式：一次调用即并行搜索全部引擎，结果自动合并去重排序。`
          : `当前为接力模式：一次调用按优先级依次尝试，某个引擎失败或没有结果时自动用下一个。`) +
        `一次调用通常已包含足够信息，不需要对同一问题反复搜索。`
      : `搜索互联网信息。（当前未启用任何搜索引擎，请在设置中开启。）`;
  return tool(
    async ({ query, limit, proxy }) => {
      // 参数一律在运行时归一化：模型传 null / 越界值时给出合理默认，而不是抛 schema 错误
      const count =
        Number.isInteger(limit) && limit! >= 1 && limit! <= 10 ? limit! : 5;
      const via = proxy ?? undefined;
      if (!enabled.length)
        return "没有可用的搜索引擎，请在设置的「搜索」页签中开启。";
      if (search.mode !== "parallel")
        return cascade(enabled, query, count, via);
      const results = await Promise.all(
        enabled.map((e) => tryEngine(e, query, count, via))
      );
      const groups = enabled
        .map((e, i) => ({ engine: e, hits: results[i].hits }))
        .filter((g) => g.hits.length);
      const errors = enabled
        .map((e, i) => (results[i].error ? `${ENGINE_LABELS[e]}：${results[i].error}` : ""))
        .filter(Boolean);
      if (!groups.length)
        return `所有引擎均未能返回结果，可稍后重试或换个关键词。\n${errors.join("\n")}`;
      const merged = mergeHits(groups);
      const header = `已合并 ${groups.length} 个引擎的结果（去重后 ${merged.length} 条）：\n\n`;
      const errNote = errors.length
        ? `\n\n（以下引擎未返回结果：${errors.join("；")}）`
        : "";
      return header + formatHits(merged) + errNote;
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

