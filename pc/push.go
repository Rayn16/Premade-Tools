package main

// Web push for the iPhone app (the Home Screen app from the relay, iOS 16.4+): when a drop is sent to a phone that
// turned notifications on, the PC sends it a pop-up through Apple's (or Google's) free push service. Standard Web
// Push: VAPID (RFC 8292) to say who's sending, aes128gcm (RFC 8291) so the push service can't read it.

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var b64 = base64.RawURLEncoding

type PushSub struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

var (
	vapidOnce sync.Once
	vapidKey  *ecdsa.PrivateKey
)

// vapid is this PC's push key, made once and kept beside the settings (phones subscribe to it).
func vapid() *ecdsa.PrivateKey {
	vapidOnce.Do(func() {
		p := filepath.Join(appDir(), "push.key")
		if b, err := os.ReadFile(p); err == nil {
			if k, err := x509.ParseECPrivateKey(b); err == nil {
				vapidKey = k
				return
			}
		}
		vapidKey, _ = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		b, _ := x509.MarshalECPrivateKey(vapidKey)
		os.MkdirAll(appDir(), 0o755)
		os.WriteFile(p, b, 0o600)
	})
	return vapidKey
}

// vapidPublic is the key a phone's pushManager.subscribe needs, base64url.
func vapidPublic() string {
	pk, _ := vapid().PublicKey.ECDH()
	return b64.EncodeToString(pk.Bytes())
}

// vapidHeader signs a short-lived ES256 token for the push service at endpoint.
func vapidHeader(endpoint string, now time.Time) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	head := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, _ := json.Marshal(map[string]any{"aud": u.Scheme + "://" + u.Host, "exp": now.Add(12 * time.Hour).Unix(), "sub": "https://github.com/Rayn16/Premade-Tools"})
	msg := head + "." + b64.EncodeToString(claims)
	h := sha256.Sum256([]byte(msg))
	r, s, err := ecdsa.Sign(rand.Reader, vapid(), h[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + msg + "." + b64.EncodeToString(sig) + ", k=" + vapidPublic(), nil
}

// encryptPush seals msg for one subscription (RFC 8291, a single aes128gcm record).
func encryptPush(sub PushSub, msg []byte) ([]byte, error) {
	uaPub, err := b64.DecodeString(strings.TrimRight(sub.Keys.P256dh, "="))
	if err != nil {
		return nil, err
	}
	auth, err := b64.DecodeString(strings.TrimRight(sub.Keys.Auth, "="))
	if err != nil {
		return nil, err
	}
	ua, err := ecdh.P256().NewPublicKey(uaPub)
	if err != nil {
		return nil, err
	}
	as, _ := ecdh.P256().GenerateKey(rand.Reader)
	secret, err := as.ECDH(ua)
	if err != nil {
		return nil, err
	}
	asPub := as.PublicKey().Bytes()
	ikm, err := hkdf.Key(sha256.New, secret, auth, "WebPush: info\x00"+string(uaPub)+string(asPub), 32)
	if err != nil {
		return nil, err
	}
	salt := make([]byte, 16)
	rand.Read(salt)
	cek, _ := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: nonce\x00", 12)
	blk, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(blk)
	var out bytes.Buffer
	out.Write(salt)
	binary.Write(&out, binary.BigEndian, uint32(4096))
	out.WriteByte(byte(len(asPub)))
	out.Write(asPub)
	out.Write(gcm.Seal(nil, nonce, append(msg, 2), nil)) // 2: the last (only) record
	return out.Bytes(), nil
}

// sendPush delivers one notification. gone is true when the push service says the subscription has ended.
func sendPush(sub PushSub, title, body string) (gone bool, err error) {
	payload, _ := json.Marshal(map[string]string{"title": title, "body": body, "tool": "drop"})
	enc, err := encryptPush(sub, payload)
	if err != nil {
		return false, err
	}
	auth, err := vapidHeader(sub.Endpoint, time.Now())
	if err != nil {
		return false, err
	}
	req, _ := http.NewRequest("POST", sub.Endpoint, bytes.NewReader(enc))
	req.Header.Set("Authorization", auth)
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", "86400")
	req.Header.Set("Urgency", "high")
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return false, err
	}
	resp.Body.Close()
	if resp.StatusCode == 404 || resp.StatusCode == 410 {
		return true, nil
	}
	if resp.StatusCode >= 300 {
		return false, fmt.Errorf("push service said %s", resp.Status)
	}
	return false, nil
}

// pushTo sends a pop-up to a phone: the iPhone app by web push, the Android app through the relay's Firebase. A
// dead subscription or token is forgotten.
func (a *App) pushTo(phoneID, title, body string) {
	var sub PushSub
	fcm := ""
	for _, p := range a.set.Get().Phones {
		if p.ID == phoneID {
			json.Unmarshal(p.Push, &sub)
			fcm = p.FCM
		}
	}
	if fcm != "" && a.set.Get().FrTok != "" {
		go func() {
			err := a.fr.call("POST", "/push", map[string]string{"token": fcm, "title": title, "body": body}, nil)
			if err != nil && strings.Contains(err.Error(), "no longer registered") {
				a.set.With(func(c *Config) bool {
					for _, p := range c.Phones {
						if p.ID == phoneID {
							p.FCM = ""
						}
					}
					return true
				})
			} else if err != nil {
				log.Printf("fcm push to %s: %v", phoneID, err)
			}
		}()
	}
	if sub.Endpoint == "" {
		return
	}
	go func() {
		gone, err := sendPush(sub, title, body)
		if err != nil {
			log.Printf("push to %s: %v", phoneID, err)
		}
		if gone {
			a.set.With(func(c *Config) bool {
				for _, p := range c.Phones {
					if p.ID == phoneID {
						p.Push = nil
					}
				}
				return true
			})
		}
	}()
}

func (a *App) hasPush(phoneID string) bool {
	for _, p := range a.set.Get().Phones {
		if p.ID == phoneID {
			return len(p.Push) > 0
		}
	}
	return false
}

// dropNote is a drop in a few words for a notification.
func dropNote(it *Drop) string {
	switch it.Kind {
	case "text", "link":
		return it.Text
	}
	if len(it.Files) == 1 {
		return it.Files[0].Name
	}
	return fmt.Sprintf("%d files", len(it.Files))
}
