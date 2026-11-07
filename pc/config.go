package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Phone struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Kind     string          `json:"kind"` // android or iphone
	Token    string          `json:"token"`
	Paired   time.Time       `json:"paired"`
	LastSeen time.Time       `json:"lastSeen"`
	Status   json.RawMessage `json:"status,omitempty"` // what the phone last reported (bin on, battery, …)
	Restores []string        `json:"restores,omitempty"`
}

type Config struct {
	VaultDir   string   `json:"vaultDir"`
	Keep       string   `json:"keep"` // forever, 2y, 1y, 6m, 3m
	SpaceSaver bool     `json:"spaceSaver"`
	Theme      string   `json:"theme"`
	Custom     string   `json:"custom"` // accent colour for the custom theme
	Size       int      `json:"size"`   // app size, percent
	WarnPhone  bool     `json:"warnPhone"`
	WarnHealth bool     `json:"warnHealth"`
	WarnSpace  bool     `json:"warnSpace"`
	StartWin   bool     `json:"startWin"`
	SetupDone  bool     `json:"setupDone"`
	DlDir      string   `json:"dlDir"`     // where downloads go; empty = Downloads\Premade
	DlNightly  bool     `json:"dlNightly"` // yt-dlp nightly builds (site fixes first)
	CvDir      string   `json:"cvDir"`     // where converted files go; empty = Downloads\Premade\Converted
	PdfDir     string   `json:"pdfDir"`    // where PDF tools save; empty = Downloads\Premade\PDF
	TrDir      string   `json:"trDir"`     // where transcripts go; empty = Downloads\Premade\Transcripts
	Phones     []*Phone `json:"phones"`
}

var keepDur = map[string]time.Duration{
	"2y": 2 * 365 * 24 * time.Hour, "1y": 365 * 24 * time.Hour,
	"6m": 182 * 24 * time.Hour, "3m": 91 * 24 * time.Hour,
}

type Settings struct {
	mu   sync.Mutex
	path string
	c    Config
}

func appDir() string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = "."
	}
	return filepath.Join(d, "Premade Tools")
}

func LoadSettings() *Settings {
	s := &Settings{path: filepath.Join(appDir(), "vault.json")}
	s.c = Config{Keep: "forever", Theme: "red", Custom: "#d9202d", Size: 100, WarnPhone: true, WarnHealth: true, WarnSpace: true, StartWin: true}
	if b, err := os.ReadFile(s.path); err == nil {
		json.Unmarshal(b, &s.c)
	}
	return s
}

// With runs f on the config under the lock and saves when f returns true.
func (s *Settings) With(f func(c *Config) bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !f(&s.c) {
		return nil
	}
	os.MkdirAll(filepath.Dir(s.path), 0o755)
	return writeJSON(s.path, s.c)
}

func (s *Settings) Get() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.c
	c.Phones = make([]*Phone, len(s.c.Phones))
	for i, p := range s.c.Phones {
		cp := *p
		c.Phones[i] = &cp
	}
	return c
}

// DownloadDir is where the Downloader saves files.
func (c Config) DownloadDir() string {
	if c.DlDir != "" {
		return c.DlDir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Downloads", "Premade")
}

// ConvertDir is where the Converter saves files.
func (c Config) ConvertDir() string {
	if c.CvDir != "" {
		return c.CvDir
	}
	return filepath.Join(c.DownloadDir(), "Converted")
}

// PdfOutDir is where the PDF tools save files.
func (c Config) PdfOutDir() string {
	if c.PdfDir != "" {
		return c.PdfDir
	}
	return filepath.Join(c.DownloadDir(), "PDF")
}

// TrOutDir is where Transcribe saves text and subtitles.
func (c Config) TrOutDir() string {
	if c.TrDir != "" {
		return c.TrDir
	}
	return filepath.Join(c.DownloadDir(), "Transcripts")
}
