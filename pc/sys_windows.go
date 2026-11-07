//go:build windows

package main

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

func hidden(c *exec.Cmd) *exec.Cmd {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	return c
}

func ps(script string) (string, error) {
	out, err := hidden(exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script)).Output()
	return strings.TrimSpace(string(out)), err
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// lowPriority keeps Vault out of the way of games: below-normal CPU plus background I/O and memory priority.
func lowPriority() {
	h := windows.CurrentProcess()
	windows.SetPriorityClass(h, windows.BELOW_NORMAL_PRIORITY_CLASS)
	windows.SetPriorityClass(h, 0x00100000) // PROCESS_MODE_BACKGROUND_BEGIN
}

// openWindow shows the screens in an Edge app window with its own small profile (no tabs, no address bar).
func openWindow(url string) {
	for _, base := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LocalAppData")} {
		edge := filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`)
		if _, err := os.Stat(edge); err == nil {
			exec.Command(edge, "--app="+url, "--window-size=1200,800",
				"--user-data-dir="+filepath.Join(appDir(), "window"), "--no-first-run").Start()
			return
		}
	}
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func setAutostart(on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		k.DeleteValue("PremadeTools")
		return nil
	}
	exe, _ := os.Executable()
	return k.SetStringValue("PremadeTools", `"`+exe+`" --background`)
}

// installSelf copies a downloaded PremadeTools.exe into %LocalAppData%\Premade Tools, adds a Start menu
// shortcut, and starts that copy. Returns true when this process should exit.
func installSelf(args []string, release func()) bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	dir := filepath.Join(os.Getenv("LocalAppData"), "Premade Tools")
	dst := filepath.Join(dir, "PremadeTools.exe")
	if strings.EqualFold(filepath.Clean(exe), dst) {
		return false
	}
	os.MkdirAll(dir, 0o755)
	if err := copyExe(exe, dst); err != nil {
		return false // run from where it is
	}
	// The APK sits next to the exe in a release download; keep it for phones to install.
	if apk := filepath.Join(filepath.Dir(exe), "PremadeTools.apk"); fileExists(apk) {
		copyExe(apk, filepath.Join(dir, "PremadeTools.apk"))
	}
	lnk := filepath.Join(os.Getenv("AppData"), `Microsoft\Windows\Start Menu\Programs\Premade Tools.lnk`)
	ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut(` + psQuote(lnk) + `);$s.TargetPath=` + psQuote(dst) + `;$s.Save()`)
	release() // free the port so the installed copy can take it
	return exec.Command(dst, args...).Start() == nil
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func copyExe(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

func diskSpace(dir string) (free, total uint64) {
	p, err := windows.UTF16PtrFromString(filepath.VolumeName(dir) + `\`)
	if err != nil {
		return
	}
	windows.GetDiskFreeSpaceEx(p, &free, &total, nil)
	return
}

type Drive struct {
	Root, Label string
	Free, Total string
	FreeB       uint64
	System      bool
}

func drives() []Drive {
	var out []Drive
	mask, _ := windows.GetLogicalDrives()
	sys := filepath.VolumeName(os.Getenv("SystemRoot"))
	for i := 0; i < 26; i++ {
		if mask&(1<<i) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		p, _ := windows.UTF16PtrFromString(root)
		if windows.GetDriveType(p) != windows.DRIVE_FIXED {
			continue
		}
		var name [261]uint16
		windows.GetVolumeInformation(p, &name[0], 261, nil, nil, nil, nil, 0)
		free, total := diskSpace(root)
		out = append(out, Drive{Root: root, Label: windows.UTF16ToString(name[:]), Free: human(int64(free)), Total: human(int64(total)), FreeB: free, System: strings.EqualFold(root[:2], sys)})
	}
	return out
}

func pickFolder() string {
	out, _ := ps(`Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='Where should your vault live?';$d.ShowNewFolderButton=$true;if($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true}))-eq'OK'){$d.SelectedPath}`)
	return out
}

// driveHealth asks Windows how the vault's physical disk is doing: Healthy, Warning or Unhealthy.
func driveHealth(dir string) string {
	letter := strings.TrimSuffix(filepath.VolumeName(dir), ":")
	if len(letter) != 1 {
		return ""
	}
	out, err := ps(`$n=(Get-Partition -DriveLetter ` + letter + ` | Get-Disk).Number; (Get-PhysicalDisk | Where-Object DeviceId -eq "$n").HealthStatus`)
	if err != nil {
		return ""
	}
	return out
}

func notify(title, msg string) {
	go ps(`Add-Type -AssemblyName System.Windows.Forms;$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Warning;$n.Visible=$true;$n.ShowBalloonTip(10000,` + psQuote(title) + `,` + psQuote(msg) + `,'Warning');Start-Sleep 12;$n.Dispose()`)
}
