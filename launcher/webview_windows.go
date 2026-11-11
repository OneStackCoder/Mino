//go:build windows

package main

import "syscall"

// WebView2 Runtime（Evergreen）在注册表里注册的 CLSID
const webView2RuntimeGUID = `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`

// 直接读注册表判断 WebView2 Runtime 是否已安装（64 位、32 位、每用户三种位置）。
// 不用 reg.exe：GUI 进程每次都 spawn 控制台程序会闪黑框，注册表 API 没有这个开销
func hasWebView2() bool {
	keys := []struct {
		root syscall.Handle
		path string
	}{
		{syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\Microsoft\EdgeUpdate\Clients\` + webView2RuntimeGUID},
		{syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\` + webView2RuntimeGUID},
		{syscall.HKEY_CURRENT_USER, `Software\Microsoft\EdgeUpdate\Clients\` + webView2RuntimeGUID},
	}
	for _, k := range keys {
		if registryKeyExists(k.root, k.path) {
			return true
		}
	}
	return false
}

func registryKeyExists(root syscall.Handle, path string) bool {
	sub, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	var h syscall.Handle
	if err := syscall.RegOpenKeyEx(root, sub, 0, syscall.KEY_READ, &h); err != nil {
		return false
	}
	syscall.RegCloseKey(h)
	return true
}
