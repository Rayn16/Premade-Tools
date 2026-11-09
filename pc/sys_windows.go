//go:build windows

package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

// hidden runs a program with no window. One that can be cancelled (exec.CommandContext sets Cancel) takes the programs
// it started down with it: yt-dlp and gallery-dl are a small starter running the real program (and ffmpeg), and
// soffice.exe runs soffice.bin, so a plain kill left those running and holding the output open.
func hidden(c *exec.Cmd) *exec.Cmd {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	if c.Cancel != nil {
		c.Cancel = func() error {
			if hidden(exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(c.Process.Pid))).Run() != nil {
				return c.Process.Kill()
			}
			return nil
		}
		c.WaitDelay = 5 * time.Second // then the output pipes close even if something still holds them
	}
	return c
}

func ps(script string) (string, error) {
	out, err := hidden(exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script)).Output()
	return strings.TrimSpace(string(out)), err
}

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
		if _, err := os.Stat(filepath.Join(dir, "icon.ico")); err != nil {
			startMenu(dir, dst) // installs from before the icon existed
		}
		return false
	}
	os.MkdirAll(dir, 0o755)
	if err := copyExe(exe, dst); err != nil {
		return false // run from where it is
	}
	startMenu(dir, dst)
	release() // free the port so the installed copy can take it
	return exec.Command(dst, args...).Start() == nil
}

// startMenu adds the Start menu entry with Premade's mark.
func startMenu(dir, exe string) {
	ico := filepath.Join(dir, "icon.ico")
	if b, err := uiFiles.ReadFile("ui/icon.ico"); err == nil {
		os.WriteFile(ico, b, 0o644)
	}
	lnk := filepath.Join(os.Getenv("AppData"), `Microsoft\Windows\Start Menu\Programs\Premade Tools.lnk`)
	ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut(` + psQuote(lnk) + `);$s.TargetPath=` + psQuote(exe) + `;$s.IconLocation=` + psQuote(ico) + `;$s.Save()`)
}

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

// pickFolder asks for a folder; ask is the question on the dialog (no ' in it).
func pickFolder(ask string) string {
	out, _ := ps(`Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='` + ask + `';$d.ShowNewFolderButton=$true;if($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true}))-eq'OK'){$d.SelectedPath}`)
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

// showInFolder opens Explorer with the file selected.
func showInFolder(path string) { exec.Command("explorer.exe", "/select,", path).Start() }

// startEdge opens a normal Edge window on its own profile with the debugging port on, for logins.
func startEdge(profile string, port int, url string) error {
	for _, base := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LocalAppData")} {
		edge := filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`)
		if _, err := os.Stat(edge); err == nil {
			return exec.Command(edge, "--user-data-dir="+profile, "--remote-debugging-port="+strconv.Itoa(port),
				"--remote-allow-origins=http://127.0.0.1", "--no-first-run", "--window-size=1000,800", url).Start()
		}
	}
	return errors.New("Microsoft Edge isn't installed")
}
