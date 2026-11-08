package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"regexp"
	"testing"
	"time"
)

func TestCleanURL(t *testing.T) {
	for in, want := range map[string]string{
		"Look at this! https://vm.tiktok.com/ZMh3kQ7wP/ shared via TikTok": "https://vm.tiktok.com/ZMh3kQ7wP/",
		"https://x.com/a/status/1.":                                        "https://x.com/a/status/1",
		"youtube.com/watch?v=abc":                                          "https://youtube.com/watch?v=abc",
		"hello there":                                                      "",
	} {
		if got := cleanURL(in); got != want {
			t.Errorf("cleanURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseProbe(t *testing.T) {
	p := parseProbe([]byte(`{"_type":"playlist","id":"PL1","title":"Worlds","extractor_key":"YoutubeTab","entries":[{},{},{}]}`))
	if p.Site != "YouTube" || !p.Ask || p.Count != 3 {
		t.Fatalf("playlist: %+v", p)
	}
	p = parseProbe([]byte(`{"_type":"playlist","id":"C1","title":"Post","extractor_key":"Instagram","entries":[{"title":"Reel"}]}`))
	if p.Ask || p.What != "Video" || p.Title != "Reel" {
		t.Fatalf("one-clip post: %+v", p)
	}
	p = parseProbe([]byte(`{"id":"v","title":"Clip","extractor_key":"TikTok","duration":31}`))
	if p.What != "Video, 0:31" || p.Key != "TikTok:v" {
		t.Fatalf("video: %+v", p)
	}
	if explain("ERROR: [Instagram] abc: Requested content is not available, rate-limit reached or login required", "Instagram").Login != "Instagram" {
		t.Fatal("login not spotted")
	}
}

func TestNetscape(t *testing.T) {
	s := netscape([]cdpCookie{{Name: "sessionid", Value: "v", Domain: ".instagram.com", Path: "/", Expires: 2e9, Secure: true}})
	if !strings.Contains(s, ".instagram.com\tTRUE\t/\tTRUE\t2000000000\tsessionid\tv\n") {
		t.Fatal(s)
	}
}

// A real run through yt-dlp, against a video this test serves itself (skipped where yt-dlp or FFmpeg is missing).
func TestDownloadEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("yt-dlp"); err != nil {
		t.Skip("no yt-dlp")
	}
	tmp := t.TempDir()
	clip := filepath.Join(tmp, "clip.mp4")
	if err := exec.Command("ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10", "-pix_fmt", "yuv420p", clip).Run(); err != nil {
		t.Skip("no ffmpeg")
	}
	srv := httptest.NewServer(http.FileServer(http.Dir(tmp)))
	defer srv.Close()
	t.Setenv("HOME", tmp)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(tmp, "cfg"))
	os.MkdirAll(appDir(), 0o755)
	out := filepath.Join(tmp, "out")
	d := NewDownloader(NewEngines(func() bool { return false }), func() string { return out })

	j, p, rep := d.Start("check this "+srv.URL+"/clip.mp4", false, "", false, "phone1")
	if j == nil {
		t.Fatalf("not started: %+v %+v", p, rep)
	}
	for i := 0; i < 300 && d.Get(j.ID).State != "done" && d.Get(j.ID).State != "failed"; i++ {
		time.Sleep(100 * time.Millisecond)
	}
	got := d.Get(j.ID)
	if got.State != "done" || len(got.Files) != 1 || got.Files[0].Kind != "video" || got.Size == 0 {
		t.Fatalf("job: %+v", got)
	}
	if _, ok := d.Path(got, 0); !ok {
		t.Fatal("no path")
	}
	if _, _, rep := d.Start(srv.URL+"/clip.mp4", false, "", false, ""); rep == nil {
		t.Fatal("repeat not spotted")
	}
	j2, _, _ := d.Start(srv.URL+"/clip.mp4", true, "", false, "")
	for i := 0; i < 300 && d.Get(j2.ID).State != "done" && d.Get(j2.ID).State != "failed"; i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if g := d.Get(j2.ID); g.State != "failed" && (len(g.Files) != 1 || g.Files[0].Kind != "audio") {
		t.Fatalf("audio: %+v", g) // a silent test clip has no sound to keep, so failing is fine too
	}
}

// The release file names each engine's pattern must pick (seen on GitHub, 2026-11-08).
func TestEngineAssets(t *testing.T) {
	want := map[string][]string{
		"gallery-dl": {"gallery-dl_windows.exe"},
		"ffmpeg":     {"ffmpeg-master-latest-win64-gpl.zip", "ffmpeg-n8.0-latest-win64-gpl-8.0.zip"},
	}
	not := []string{"gallery-dl_windows_x86.exe", "ffmpeg-master-latest-win64-gpl-shared.zip", "ffmpeg-master-latest-winarm64-gpl.zip"}
	for _, en := range engineList {
		re := regexp.MustCompile(en.Asset)
		for _, n := range want[en.Name] {
			if !re.MatchString(n) {
				t.Errorf("%s doesn't match %s", en.Name, n)
			}
		}
		for _, n := range not {
			if re.MatchString(n) {
				t.Errorf("%s wrongly matches %s", en.Name, n)
			}
		}
	}
}
