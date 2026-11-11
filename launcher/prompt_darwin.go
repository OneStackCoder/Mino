//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>

static void showAlert(const char *text, const char *caption) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = [NSString stringWithUTF8String:caption];
        alert.informativeText = [NSString stringWithUTF8String:text];
        alert.alertStyle = NSAlertStyleWarning;
        [alert addButtonWithTitle:@"OK"];
        [alert runModal];
        [alert release];
    }
}
*/
import "C"

import (
	"os/exec"
	"unsafe"
)

func messageBox(text, caption string) {
	ctext := C.CString(text)
	ccaption := C.CString(caption)
	defer C.free(unsafe.Pointer(ctext))
	defer C.free(unsafe.Pointer(ccaption))
	C.showAlert(ctext, ccaption)
}

func openURL(url string) {
	_ = exec.Command("open", url).Start()
}

func promptMissingNode() {
	messageBox(
		"未检测到 Node.js（需 v24 或更高版本）。\n"+
			"请先到 https://nodejs.org 下载并安装，然后重新运行本程序。",
		"Mino",
	)
	openURL("https://nodejs.org")
}

func promptNodeTooOld() {
	messageBox(
		"当前 Node.js 版本过低，需要 v24 或更高版本。\n"+
			"请到 https://nodejs.org 升级后重新运行。",
		"Mino",
	)
	openURL("https://nodejs.org")
}

func promptMissingWebView2() {
	// macOS 上 hasWebView2() 恒为 true，此分支不会触发
	messageBox("未检测到 WebView2 运行时。", "Mino")
}

func promptMissingApp(path string) {
	messageBox("找不到应用文件，请确保程序与 app 目录放在一起：\n"+path, "Mino")
}