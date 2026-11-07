package main

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestKindsAndChecks(t *testing.T) {
	if KindOf("IMG_0001.HEIC").ID != "image" || KindOf("a.MOV").ID != "video" || KindOf("x.docx").ID != "doc" || KindOf("a.zip") != nil {
		t.Fatal("KindOf")
	}
	c := &Converter{bin: func(string) string { return "x" }}
	for _, tc := range []struct {
		names   []string
		to      string
		combine bool
		bad     string
	}{
		{[]string{"a.heic", "b.jpg"}, "pdf", true, ""},
		{[]string{"a.heic", "b.mov"}, "jpg", false, "one kind"},
		{[]string{"a.mov"}, "docx", false, "can't become"},
		{[]string{"a.pdf"}, "jpg", false, "PDFs"},
		{[]string{"a.mov"}, "mp4", true, "Only pictures"},
	} {
		_, why := c.Check(tc.names, tc.to, tc.combine)
		if (tc.bad == "") != (why == "") || !strings.Contains(why, tc.bad) {
			t.Errorf("Check(%v, %s) = %q, want %q", tc.names, tc.to, why, tc.bad)
		}
	}
	c.bin = func(string) string { return "" }
	if _, why := c.Check([]string{"a.docx"}, "pdf", false); !strings.Contains(why, "LibreOffice") {
		t.Errorf("missing engine: %q", why)
	}
	if cleanName(`..\..\evil<1>.jpg`, 0) != "evil_1_.jpg" || cleanName("...", 2) != "file3" {
		t.Errorf("cleanName: %q %q", cleanName(`..\..\evil<1>.jpg`, 0), cleanName("...", 2))
	}
	if targetID(KindOf("a.docx"), "Word") != "docx" || targetID(KindOf("a.png"), "JPG") != "jpg" {
		t.Error("targetID")
	}
}

func TestUnpack7z(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "magick")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "stale.dll"), []byte("old"), 0o644)
	if err := unpack7z("testdata/wrapped.7z", dir); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "magick.exe")); string(b) != "MZfake" {
		t.Fatalf("magick.exe not lifted to the top: %q", b)
	}
	if _, err := os.Stat(filepath.Join(dir, "sub", "a.txt")); err != nil {
		t.Fatal("subfolder lost")
	}
	if _, err := os.Stat(filepath.Join(dir, "stale.dll")); err == nil {
		t.Fatal("old copy kept")
	}
}

// TestConvertEndToEnd runs real conversions with the engines on PATH (skipped where they're missing).
func TestConvertEndToEnd(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	a := &App{set: LoadSettings()}
	out := t.TempDir()
	a.set.With(func(c *Config) bool { c.CvDir = out; return true })
	a.cv = NewConverter(a.cvBin, func() string { return a.set.Get().ConvertDir() })
	srv := httptest.NewServer(a.routesForTest())
	defer srv.Close()
	src := t.TempDir()

	need := func(e string) bool {
		if a.cvBin(e) == "" {
			t.Logf("no %s here, skipping its cases", e)
			return false
		}
		return true
	}
	run := func(to, q string, files ...string) *CvJob {
		t.Helper()
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		for _, f := range files {
			w, _ := mw.CreateFormFile("f", filepath.Base(f))
			b, _ := os.ReadFile(f)
			w.Write(b)
		}
		mw.Close()
		req, _ := http.NewRequest("POST", srv.URL+"/api/ui/cv/start?to="+to+q, &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("X-Vault", "1")
		req.Host = "127.0.0.1:47110"
		resp, err := http.DefaultClient.Do(req)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("start %s: %v %v", to, err, resp.Status)
		}
		resp.Body.Close()
		for i := 0; i < 600; i++ {
			for _, j := range a.cv.Jobs("") {
				if (j.State == "done" || j.State == "failed") && j.Target == to && len(j.Inputs) == len(files) && filepath.Base(files[0]) == j.Inputs[0] {
					if j.State == "failed" {
						t.Fatalf("%v → %s failed: %s", files, to, j.Note)
					}
					a.cv.Remove(j.ID)
					return &j
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("%s timed out: %+v", to, a.cv.Jobs(""))
		return nil
	}
	if need("magick") {
		png := filepath.Join(src, "shot.png")
		if err := exec.Command(a.cvBin("magick"), "-size", "300x200", "gradient:red-blue", png).Run(); err != nil {
			t.Fatal(err)
		}
		png2 := filepath.Join(src, "two.png")
		exec.Command(a.cvBin("magick"), "-size", "200x300", "xc:green", png2).Run()
		if j := run("jpg", "&small=1", png); j.Files[0].Name != "shot.jpg" {
			t.Errorf("jpg: %+v", j.Files)
		}
		if j := run("pdf", "&combine=1", png, png2); len(j.Files) != 1 || j.Files[0].Name != "shot and 1 more.pdf" {
			t.Errorf("combined pdf: %+v", j.Files)
		}
		if j := run("jpg", "", png); j.Files[0].Name != "shot (2).jpg" {
			t.Errorf("repeat name: %+v", j.Files)
		}
	}
	if need("ffmpeg") {
		mov := filepath.Join(src, "clip.mov")
		if err := exec.Command(a.cvBin("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "testsrc=s=320x240:d=2", "-f", "lavfi", "-i", "sine=d=2",
			"-shortest", "-c:v", "mpeg4", "-c:a", "aac", mov).Run(); err != nil {
			t.Fatal(err)
		}
		for _, to := range []string{"mp4", "gif", "mp3", "webm"} {
			if j := run(to, "", mov); j.Files[0].Size == 0 {
				t.Errorf("%s: empty", to)
			}
		}
	}
	if need("soffice") && os.Getenv("CI") == "" {
		txt := filepath.Join(src, "notes.txt")
		os.WriteFile(txt, []byte("Hello from the converter.\n"), 0o644)
		for _, to := range []string{"pdf", "docx"} {
			if j := run(to, "", txt); !strings.HasSuffix(j.Files[0].Name, "."+to) {
				t.Errorf("%s: %+v", to, j.Files)
			}
		}
	}
	// A broken file fails in plain words instead of hanging.
	bad := filepath.Join(src, "broken.mov")
	os.WriteFile(bad, []byte("not a video"), 0o644)
	if need("ffmpeg") {
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		w, _ := mw.CreateFormFile("f", "broken.mov")
		w.Write([]byte("not a video"))
		mw.Close()
		req, _ := http.NewRequest("POST", srv.URL+"/api/ui/cv/start?to=mp4", &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("X-Vault", "1")
		req.Host = "127.0.0.1:47110"
		resp, _ := http.DefaultClient.Do(req)
		resp.Body.Close()
		for i := 0; i < 100; i++ {
			if js := a.cv.Jobs(""); len(js) > 0 && js[0].State == "failed" {
				if !strings.Contains(js[0].Note, "couldn't be read") {
					t.Errorf("note: %q", js[0].Note)
				}
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Error("broken file didn't fail")
	}
}

func (a *App) routesForTest() http.Handler {
	m := http.NewServeMux()
	a.cvRoutes(m)
	return m
}
