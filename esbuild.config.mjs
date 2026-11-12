import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { minify } from "html-minifier-terser";

// jsdom 在模块加载时就用 require.resolve 定位同步 XHR 的 worker 文件。
// 本项目只用 JSDOM 解析静态 HTML，不执行页面脚本，同步 XHR 走不到；
// 打包后该相对路径也不存在，所以直接在源码里把这行引用去掉。
const SYNC_WORKER_LINE = 'const syncWorkerFile = require.resolve("./xhr-sync-worker.js");';

// 产物统一输出到 build/app/app.mjs，launcher 与打包脚本都按 app/app.mjs 找入口。
// --local 额外补齐静态资源、node_modules 链接，并编译本平台 launcher。
const local = process.argv.includes("--local");
const appDir = "build/app";
if (local) {
  await fs.rm(appDir, { recursive: true, force: true });
}

await build({
  entryPoints: ["src/agent.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "bundle",
  external: ["better-sqlite3", "@webviewjs/webview", "@webviewjs/webview-*"],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  outfile: `${appDir}/app.mjs`,
  plugins: [
    {
      name: "drop-jsdom-sync-xhr-worker",
      setup(build) {
        build.onLoad(
          { filter: /jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/ },
          async ({ path }) => {
            const source = await fs.readFile(path, "utf8");
            if (!source.includes(SYNC_WORKER_LINE)) {
              throw new Error(`jsdom 同步 XHR worker 引用位置变了，请更新 esbuild.config.mjs：${path}`);
            }
            return {
              contents: source.replace(SYNC_WORKER_LINE, "const syncWorkerFile = null;"),
              loader: "js",
            };
          },
        );
      },
    },
  ],
});

// 复制静态资源；index.html 是内联全部 JS/CSS 的单文件前端，顺带压缩体积
async function stagePublic() {
  const dest = `${appDir}/public`;
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp("public", dest, { recursive: true });
  const indexFile = `${dest}/index.html`;
  const html = await fs.readFile(indexFile, "utf8");
  const minified = await minify(html, {
    collapseWhitespace: true,
    // 保留一个空格，避免把行内元素之间的空白删光导致文字粘连
    conservativeCollapse: true,
    removeComments: true,
    minifyCSS: true,
    minifyJS: true,
  });
  await fs.writeFile(indexFile, minified);
}

await stagePublic();

// 补齐运行所需的 node_modules 链接（用相对符号链接指回仓库根目录，避免每次复制几百 MB），
// 再编译本平台 launcher 到 build/，与 app/ 同级即可直接启动。
if (local) {
  const windows = process.platform === "win32";
  await fs.symlink(
    windows ? "..\\..\\node_modules" : "../../node_modules",
    `${appDir}/node_modules`,
    windows ? "junction" : "dir",
  );

  const bin = windows ? "Mino.exe" : "Mino";
  const result = spawnSync("go", ["build", "-ldflags", windows ? "-s -w -H windowsgui" : "-s -w", "-o", `../build/${bin}`, "."], {
    cwd: "launcher",
    stdio: "inherit",
    // macOS 的 webview 需要 cgo；Linux / Windows 产物不依赖 cgo
    env: { ...process.env, CGO_ENABLED: process.platform === "darwin" ? "1" : "0" },
  });
  if (result.error?.code === "ENOENT") {
    console.warn("未找到 go 命令，已跳过 launcher 编译（装好 Go 后重跑即可）");
    console.log(`本地产物：${appDir}（可用 node ${appDir}/app.mjs 运行）`);
  } else if (result.status !== 0) {
    process.exit(1);
  } else {
    console.log(`本地产物：${appDir} + build/${bin}（直接运行 build/${bin}）`);
  }
}
