package main

// Logins for the Downloader. Some posts (Instagram stories, private or age-limited videos) need a logged-in
// account. Chrome and Edge lock their cookies so other programs can't read them, so instead Premade Tools opens
// its own small Edge window, you log in there once, and it asks that window for its cookies over Edge's
// debugging port (only on this PC) and keeps them in cookies.txt for yt-dlp and gallery-dl.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/net/websocket"
)

const debugPort = 47119

var loginSites = map[string]string{
	"instagram": "https://www.instagram.com/accounts/login/",
	"x":         "https://x.com/i/flow/login",
	"tiktok":    "https://www.tiktok.com/login",
	"youtube":   "https://accounts.google.com/ServiceLogin?service=youtube",
	"facebook":  "https://www.facebook.com/login/",
	"reddit":    "https://www.reddit.com/login/",
}

// OpenLogin shows the login window and keeps saving its cookies until it closes.
func (d *Downloader) OpenLogin(site string) error {
	u, ok := loginSites[site]
	if !ok {
		return fmt.Errorf("unknown site")
	}
	if err := startEdge(filepath.Join(appDir(), "login"), debugPort, u); err != nil {
		return err
	}
	go func() {
		ok := false
		for i := 0; i < 1800; i++ { // every 2 s, so a window closed right after logging in still had its cookies saved; up to an hour
			time.Sleep(2 * time.Second)
			err := d.saveCookies()
			if err != nil && (ok || i >= 30) {
				return // the window is closed, or didn't open within a minute
			}
			ok = ok || err == nil
		}
	}()
	return nil
}

func (d *Downloader) saveCookies() error {
	cl := &http.Client{Timeout: 3 * time.Second}
	resp, err := cl.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", debugPort))
	if err != nil {
		return err
	}
	var v struct {
		WS string `json:"webSocketDebuggerUrl"`
	}
	err = json.NewDecoder(resp.Body).Decode(&v)
	resp.Body.Close()
	if err != nil || v.WS == "" {
		return fmt.Errorf("no debugger")
	}
	ws, err := websocket.Dial(v.WS, "", "http://127.0.0.1") // exactly what Edge was started to allow (startEdge), or it says 403
	if err != nil {
		return err
	}
	defer ws.Close()
	ws.SetDeadline(time.Now().Add(10 * time.Second))
	if err := websocket.JSON.Send(ws, map[string]any{"id": 1, "method": "Storage.getCookies"}); err != nil {
		return err
	}
	for {
		var r struct {
			ID     int `json:"id"`
			Result struct {
				Cookies []cdpCookie `json:"cookies"`
			} `json:"result"`
		}
		if err := websocket.JSON.Receive(ws, &r); err != nil {
			return err
		}
		if r.ID == 1 {
			if len(r.Result.Cookies) == 0 {
				return nil
			}
			return os.WriteFile(d.cookies, []byte(netscape(r.Result.Cookies)), 0o600)
		}
	}
}

type cdpCookie struct {
	Name, Value, Domain, Path string
	Expires                   float64
	Secure                    bool
}

// netscape writes cookies in the cookies.txt format yt-dlp and gallery-dl read.
func netscape(cs []cdpCookie) string {
	var b strings.Builder
	b.WriteString("# Netscape HTTP Cookie File\n")
	for _, c := range cs {
		sub := "FALSE"
		if strings.HasPrefix(c.Domain, ".") {
			sub = "TRUE"
		}
		sec := "FALSE"
		if c.Secure {
			sec = "TRUE"
		}
		exp := int64(c.Expires)
		if exp < 0 {
			exp = 0
		}
		fmt.Fprintf(&b, "%s\t%s\t%s\t%s\t%d\t%s\t%s\n", c.Domain, sub, c.Path, sec, exp, c.Name, c.Value)
	}
	return b.String()
}

// LoggedIn lists the sites cookies.txt holds a login for.
func (d *Downloader) LoggedIn() []string {
	b, _ := os.ReadFile(d.cookies)
	out := []string{}
	for _, l := range [][3]string{{"instagram", "instagram.com", "sessionid"}, {"x", "x.com", "auth_token"}, {"tiktok", "tiktok.com", "sessionid"},
		{"youtube", "youtube.com", "SAPISID"}, {"facebook", "facebook.com", "c_user"}, {"reddit", "reddit.com", "reddit_session"}} {
		for _, line := range strings.Split(string(b), "\n") {
			if f := strings.Split(line, "\t"); len(f) == 7 && strings.HasSuffix(f[0], l[1]) && f[5] == l[2] {
				out = append(out, l[0])
				break
			}
		}
	}
	return out
}

// ForgetLogins deletes the saved cookies and the login window's profile.
func (d *Downloader) ForgetLogins() {
	os.Remove(d.cookies)
	if err := os.RemoveAll(filepath.Join(appDir(), "login")); err != nil {
		log.Printf("forget logins: %v", err)
	}
}
