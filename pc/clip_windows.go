//go:build windows

package main

// The Windows clipboard for File drop, straight through user32 (a PowerShell per check would be far too slow).

import (
	"os"
	"os/exec"
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")
	cbSeq    = user32.NewProc("GetClipboardSequenceNumber")
	cbOpen   = user32.NewProc("OpenClipboard")
	cbClose  = user32.NewProc("CloseClipboard")
	cbEmpty  = user32.NewProc("EmptyClipboard")
	cbGet    = user32.NewProc("GetClipboardData")
	cbSet    = user32.NewProc("SetClipboardData")
	cbHas    = user32.NewProc("IsClipboardFormatAvailable")
	gAlloc   = kernel32.NewProc("GlobalAlloc")
	gFree    = kernel32.NewProc("GlobalFree")
	gLock    = kernel32.NewProc("GlobalLock")
	gUnlock  = kernel32.NewProc("GlobalUnlock")
)

const cfUnicodeText = 13

func clipSeqNow() uint32 { n, _, _ := cbSeq.Call(); return uint32(n) }

// openClip waits a little while another program holds the clipboard.
func openClip() bool {
	for i := 0; i < 10; i++ {
		if r, _, _ := cbOpen.Call(0); r != 0 {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func clipGet() (string, bool) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if r, _, _ := cbHas.Call(cfUnicodeText); r == 0 || !openClip() {
		return "", false
	}
	defer cbClose.Call()
	h, _, _ := cbGet.Call(cfUnicodeText)
	if h == 0 {
		return "", false
	}
	p, _, _ := gLock.Call(h)
	if p == 0 {
		return "", false
	}
	defer gUnlock.Call(h)
	return windows.UTF16PtrToString((*uint16)(unsafe.Pointer(p))), true
}

func clipSet(s string) {
	u, err := windows.UTF16FromString(s)
	if err != nil {
		return
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if !openClip() {
		return
	}
	defer cbClose.Call()
	cbEmpty.Call()
	h, _, _ := gAlloc.Call(0x0002, uintptr(len(u)*2)) // GMEM_MOVEABLE
	if h == 0 {
		return
	}
	p, _, _ := gLock.Call(h)
	if p == 0 {
		gFree.Call(h)
		return
	}
	copy(unsafe.Slice((*uint16)(unsafe.Pointer(p)), len(u)), u)
	gUnlock.Call(h)
	if r, _, _ := cbSet.Call(cfUnicodeText, h); r == 0 {
		gFree.Call(h)
	}
}

// say is a plain notification (notify is for warnings). Clicking it opens the window on page.
func say(title, msg, page string) {
	exe, _ := os.Executable()
	go ps(`Add-Type -AssemblyName System.Windows.Forms;$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;` +
		`$n.add_BalloonTipClicked({Start-Process -FilePath ` + psQuote(exe) + ` -ArgumentList '-open',` + psQuote(page) + `});` +
		`$n.ShowBalloonTip(8000,` + psQuote(title) + `,` + psQuote(msg) + `,'Info');` +
		`$end=(Get-Date).AddSeconds(12);while((Get-Date) -lt $end){[System.Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 100};$n.Dispose()`)
}

func openURL(u string) {
	hidden(exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", u)).Start()
}
