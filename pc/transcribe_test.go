package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A fake whisper-cli on PATH stands in for the real one: it checks its arguments, prints progress and the
// language the way whisper.cpp does, and writes the .txt and .srt.
func TestTranscribe(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("no ffmpeg")
	}
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "whisper-cli"), []byte(`#!/bin/sh
base=""; tr=""
while [ $# -gt 0 ]; do case "$1" in -of) base="$2"; shift;; -tr) tr=1;; esac; shift; done
echo "whisper_full_with_state: auto-detected language: ar (p = 0.97)" >&2
echo "whisper_print_progress_callback: progress =  50%" >&2
printf 'مرحبا%s\n' "$tr" > "$base.txt"
printf '1\n00:00:00,000 --> 00:00:01,000\nمرحبا\n' > "$base.srt"
`), 0o755)
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())

	in, out := t.TempDir(), t.TempDir()
	if b, err := exec.Command("ffmpeg", "-f", "lavfi", "-i", "sine=d=1", "-y", filepath.Join(in, "memo.m4a")).CombinedOutput(); err != nil {
		t.Fatal(err, string(b))
	}
	if why := TrCheck([]string{"x.pdf"}); why == "" {
		t.Fatal("a PDF should be refused")
	}
	os.MkdirAll(filepath.Dir(whisper.Model("en")), 0o755)
	os.WriteFile(whisper.Model("en"), make([]byte, 101<<20), 0o644) // big enough to count as fetched
	c := &Converter{bin: func(string) string { return "ffmpeg" }}
	j := &CvJob{ID: "j1", Inputs: []string{"memo.m4a"}, Target: "en"}
	made, fails := c.trWork(context.Background(), j, in, out, func(float64) {})
	if len(fails) > 0 || len(made) != 2 {
		t.Fatalf("made %v, fails %v", made, fails)
	}
	if b, _ := os.ReadFile(filepath.Join(out, "memo.txt")); !strings.Contains(string(b), "مرحبا1") {
		t.Fatalf("txt = %q (translate flag lost?)", b)
	}
	if _, err := os.Stat(filepath.Join(out, "memo.srt")); err != nil {
		t.Fatal(err)
	}
	if _, lang, _ := c.transcribe(context.Background(), "text", filepath.Join(in, "memo.m4a"), in, out, "memo", func(float64) {}); lang != "Arabic" {
		t.Fatalf("lang = %q", lang)
	}
}
