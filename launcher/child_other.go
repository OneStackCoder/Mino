//go:build !windows

package main

import (
	"os"
	"os/exec"
)

// 非 Windows 平台不存在独立控制台窗口，无需处理
func hideConsole(cmd *exec.Cmd) {}

func configureChild(cmd *exec.Cmd) {
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
}
