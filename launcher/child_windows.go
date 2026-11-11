//go:build windows

package main

import (
	"io"
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW：让子进程 node.exe 不再弹出黑框控制台
const createNoWindow = 0x08000000

// 父进程是 windowsgui 子系统，本身没有控制台；子进程只要是控制台程序就会新建一个窗口，
// 因此所有 exec 都必须先调用它（包括 --version、reg query 这类短命命令）
func hideConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}

func configureChild(cmd *exec.Cmd) {
	hideConsole(cmd)
	// 没有控制台，丢弃输出避免写入报错
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
}
