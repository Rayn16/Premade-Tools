package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"math/big"
	"strings"
	"testing"
	"time"
)

// Plays the phone: subscribes, then decrypts what encryptPush made (RFC 8291) and checks the VAPID signature.
func TestPush(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	ua, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	var sub PushSub
	sub.Endpoint = "https://web.push.apple.com/QGx1"
	sub.Keys.P256dh, sub.Keys.Auth = b64.EncodeToString(ua.PublicKey().Bytes()), b64.EncodeToString(auth)

	body, err := encryptPush(sub, []byte(`{"title":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	salt, idlen := body[:16], int(body[20])
	asPub, ct := body[21:21+idlen], body[21+idlen:]
	as, err := ecdh.P256().NewPublicKey(asPub)
	if err != nil {
		t.Fatal(err)
	}
	secret, _ := ua.ECDH(as)
	ikm, _ := hkdf.Key(sha256.New, secret, auth, "WebPush: info\x00"+string(ua.PublicKey().Bytes())+string(asPub), 32)
	cek, _ := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: nonce\x00", 12)
	blk, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(blk)
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil || string(plain) != "{\"title\":\"hi\"}\x02" {
		t.Fatalf("decrypt: %q %v", plain, err)
	}

	h, err := vapidHeader(sub.Endpoint, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	tok := strings.TrimPrefix(strings.Split(h, ", k=")[0], "vapid t=")
	parts := strings.Split(tok, ".")
	sig, _ := b64.DecodeString(parts[2])
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(&vapid().PublicKey, sum[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("VAPID signature doesn't verify")
	}
	if claims, _ := b64.DecodeString(parts[1]); !strings.Contains(string(claims), `"aud":"https://web.push.apple.com"`) {
		t.Fatalf("claims %s", claims)
	}
	if !strings.HasSuffix(h, "k="+vapidPublic()) || len(vapidPublic()) != 87 {
		t.Fatal("public key")
	}
}
