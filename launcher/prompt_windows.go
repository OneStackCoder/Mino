//go:build windows

package main

import (
	"os/exec"
	"syscall"
	"unsafe"
)

func messageBox(text, caption string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(caption)
	// MB_OK | MB_ICONWARNING = 0x30
	proc.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x30)
}

func openURL(url string) {
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func promptMissingNode() {
	messageBox(
		"未检测到 Node.js（需 v24 或更高版本）。\n\n"+
			"请先到 https://nodejs.org 下载并安装，然后重新运行本程序。",
		"Mino",
	)
	openURL("https://nodejs.org")
}

func promptNodeTooOld() {
	messageBox(
		"当前 Node.js 版本过低，需要 v24 或更高版本。\n\n"+
			"请到 https://nodejs.org 升级后重新运行。",
		"Mino",
	)
	openURL("https://nodejs.org")
}

func promptMissingWebView2() {
	messageBox(
		"未检测到 Microsoft Edge WebView2 运行时。\n\n"+
			"本程序界面依赖 WebView2，请先下载安装「WebView2 Runtime」，然后重新运行。",
		"Mino",
	)
	openURL("https://developer.microsoft.com/microsoft-edge/webview2/")
}

func promptMissingApp(path string) {
	messageBox("找不到应用文件，请确保 exe 与 app 目录放在一起：\n"+path, "Mino")
}