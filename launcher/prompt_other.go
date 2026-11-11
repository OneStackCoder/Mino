//go:build !windows && !darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
)

func promptMissingNode() {
	notify("未检测到 Node.js（需 v24 或更高版本）。请先安装：https://nodejs.org")
}

func promptNodeTooOld() {
	notify("Node.js 版本过低，需 v24 或更高版本：https://nodejs.org")
}

func promptMissingWebView2() {
	notify("未检测到 WebView2 运行时：https://developer.microsoft.com/microsoft-edge/webview2/")
}

func promptMissingApp(path string) {
	notify("找不到应用文件: " + path)
}

// 双击启动时没有终端，优先用桌面弹窗；弹窗不可用时退回 stderr
func notify(msg string) {
	dialogs := [][]string{
		{"zenity", "--info", "--title", "Mino", "--text", msg},
		{"kdialog", "--title", "Mino", "--msgbox", msg},
	}
	for _, args := range dialogs {
		if _, err := exec.LookPath(args[0]); err != nil {
			continue
		}
		if exec.Command(args[0], args[1:]...).Run() == nil {
			return
		}
	}
	fmt.Fprintln(os.Stderr, msg)
}
