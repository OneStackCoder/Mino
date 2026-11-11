//go:build !windows

package main

// 非 Windows 平台用 WebKitGTK / WKWebView，无需 WebView2
func hasWebView2() bool {
	return true
}