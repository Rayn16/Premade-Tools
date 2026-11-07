//go:build !windows

package main

// Stand-ins so the program builds and tests on Linux; Vault itself is for Windows.

import (
	"errors"
	"log"
	"os/exec"
	"syscall"
)

type Drive struct {
	Root, Label string
	Free, Total string
	FreeB       uint64
	System      bool
}

func lowPriority()                                   {}
func openWindow(url string)                          { log.Println("window:", url) }
func setAutostart(on bool) error                     { return nil }
func installSelf(args []string, release func()) bool { return false }
func pickFolder() string                             { return "" }
func driveHealth(dir string) string                  { return "Healthy" }
func notify(title, msg string)                       { log.Println("notify:", msg) }
func drives() []Drive {
	f, t := diskSpace("/")
	return []Drive{{Root: "/", Label: "root", Free: human(int64(f)), Total: human(int64(t)), FreeB: f, System: true}}
}
func diskSpace(dir string) (free, total uint64) {
	var s syscall.Statfs_t
	if syscall.Statfs(dir, &s) == nil {
		free, total = s.Bavail*uint64(s.Bsize), s.Blocks*uint64(s.Bsize)
	}
	return
}
func hidden(c *exec.Cmd) *exec.Cmd                         { return c }
func showInFolder(path string)                             { log.Println("show:", path) }
func startEdge(profile string, port int, url string) error { return errors.New("logins need Windows") }
