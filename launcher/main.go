package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// 与应用 package.json 的 engines 保持一致
const minNodeMajor = 24

func main() {
	node, sawNode := findNode()
	if node == "" {
		if sawNode {
			promptNodeTooOld()
		} else {
			promptMissingNode()
		}
		os.Exit(1)
	}

	// WebView2 运行时：webview 窗口在 Windows 上依赖它，缺失时双击无窗口或直接报错
	if !hasWebView2() {
		promptMissingWebView2()
		os.Exit(1)
	}

	// 入口脚本：与 exe 同目录的 app\app.mjs（由 esbuild 打包 src 生成）
	exe, err := os.Executable()
	if err != nil {
		promptMissingApp("(无法定位 exe 路径)")
		os.Exit(1)
	}
	appDir := filepath.Dir(exe)
	entry := filepath.Join(appDir, "app", "app.mjs")
	if _, err := os.Stat(entry); err != nil {
		promptMissingApp(entry)
		os.Exit(1)
	}

	cmd := exec.Command(node, entry)
	configureChild(cmd)
	cmd.Dir = filepath.Join(appDir, "app")
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		fmt.Fprintln(os.Stderr, "运行失败:", err)
		os.Exit(1)
	}
}

// 双击启动时 GUI 的 PATH 通常不含 nvm 等用户级目录，需要在常见位置补找。
// 返回 (可用 node 路径, 是否见过 node 但版本不达标)
func findNode() (string, bool) {
	sawNode := false
	if p, err := exec.LookPath("node"); err == nil {
		if major, ok := nodeMajor(p); ok && major >= minNodeMajor {
			return p, false
		}
		sawNode = true
	}
	home, _ := os.UserHomeDir()
	var candidates []string
	if home != "" {
		if matches, _ := filepath.Glob(filepath.Join(home, ".nvm/versions/node/*/bin/node")); len(matches) > 0 {
			// nvm 目录名自带版本号，从高到低排序，优先命中新版本、减少探测次数
			sort.Slice(matches, func(i, j int) bool {
				return versionMajor(matches[i]) > versionMajor(matches[j])
			})
			candidates = append(candidates, matches...)
		}
		candidates = append(candidates,
			filepath.Join(home, ".local/bin/node"),
			filepath.Join(home, ".volta/bin/node"),
			filepath.Join(home, ".fnm/aliases/default/bin/node"),
		)
	}
	candidates = append(candidates, "/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node")

	for _, c := range candidates {
		if _, err := os.Stat(c); err != nil {
			continue
		}
		sawNode = true
		if major, ok := nodeMajor(c); ok && major >= minNodeMajor {
			return c, true
		}
	}
	return "", sawNode
}

// 解析 node --version（形如 v24.1.0）的主版本号
func nodeMajor(node string) (int, bool) {
	cmd := exec.Command(node, "--version")
	hideConsole(cmd)
	out, err := cmd.Output()
	if err != nil {
		return 0, false
	}
	v := strings.TrimPrefix(strings.TrimSpace(string(out)), "v")
	parts := strings.SplitN(v, ".", 2)
	if len(parts) == 0 || parts[0] == "" {
		return 0, false
	}
	n, err := strconv.Atoi(parts[0])
	return n, err == nil
}

// 从 .../node/v24.20.0/bin/node 中取主版本号，解析失败返回 -1
func versionMajor(p string) int {
	name := filepath.Base(filepath.Dir(filepath.Dir(p)))
	parts := strings.SplitN(strings.TrimPrefix(name, "v"), ".", 2)
	if len(parts) == 0 {
		return -1
	}
	n, err := strconv.Atoi(parts[0])
	if err != nil {
		return -1
	}
	return n
}
