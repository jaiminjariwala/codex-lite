package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/store"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestBrowserOAuthHandoff(t *testing.T) {
	s := newTestServer(store.NewMemory())
	if got := request(t, s, "POST", "/v1/auth/github/start", "", `{}`); got.Code != 503 {
		t.Fatal(got.Code)
	}
	s.config.GitHubClientID = "client"
	s.config.GitHubClientSecret = "secret"
	s.config.GitHubRedirectURL = "http://127.0.0.1:8787/v1/auth/github/callback"
	started := request(t, s, "POST", "/v1/auth/github/start", "", `{}`)
	var result map[string]string
	if err := json.Unmarshal(started.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(result["authorization_url"])
	item := s.oauth.entries[result["state"]]
	hash := sha256.Sum256([]byte(item.verifier))
	if u.Query().Get("code_challenge") != base64.RawURLEncoding.EncodeToString(hash[:]) || u.Query().Get("code_challenge_method") != "S256" {
		t.Fatal("missing PKCE")
	}
	if strings.Contains(started.Body.String(), "secret") {
		t.Fatal("secret exposed")
	}
	body := `{"state":"` + result["state"] + `","poll_token":"` + result["poll_token"] + `"}`
	if got := request(t, s, "POST", "/v1/auth/github/poll", "", body); got.Code != 202 {
		t.Fatal(got.Code)
	}
	if got := request(t, s, "POST", "/v1/auth/github/poll", "", `{"state":"`+result["state"]+`","poll_token":"wrong"}`); got.Code != 401 {
		t.Fatal(got.Code)
	}
	item.token = "test-token"
	got := request(t, s, "POST", "/v1/auth/github/poll", "", body)
	if got.Code != 200 || got.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(got.Code)
	}
	if got := request(t, s, "POST", "/v1/auth/github/poll", "", body); got.Code != 401 {
		t.Fatal("replayed handoff")
	}
}

func TestOAuthCallbackAndExpiration(t *testing.T) {
	s := newTestServer(store.NewMemory())
	if got := request(t, s, "GET", "/v1/auth/github/callback?state=unknown", "", ""); got.Code != 400 {
		t.Fatal(got.Code)
	}
	s.oauth.entries["expired"] = &oauthAttempt{expires: time.Now().Add(-time.Minute)}
	if got := request(t, s, "GET", "/v1/auth/github/callback?state=expired", "", ""); got.Code != 400 {
		t.Fatal(got.Code)
	}
	s.oauth.entries["denied"] = &oauthAttempt{expires: time.Now().Add(time.Minute)}
	if got := request(t, s, "GET", "/v1/auth/github/callback?state=denied&error=access_denied", "", ""); got.Code != 400 {
		t.Fatal(got.Code)
	}
	if s.oauth.entries["denied"].failure == "" {
		t.Fatal("missing denial")
	}
}
