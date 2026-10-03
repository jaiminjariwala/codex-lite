package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/store"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

type googleTransport func(*http.Request) (*http.Response, error)

func (f googleTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestGoogleBrowserLogin(t *testing.T) {
	for _, verified := range []bool{true, false} {
		s := newTestServer(store.NewMemory())
		if got := request(t, s, "POST", "/v1/auth/google/start", "", `{}`); got.Code != 503 {
			t.Fatal("unconfigured login accepted")
		}
		s.config.GoogleClientID = "client"
		s.config.GoogleClientSecret = "private-secret"
		s.config.GoogleRedirectURL = "http://127.0.0.1:8787/v1/auth/google/callback"
		var verifier string
		s.config.AuthHTTPClient = &http.Client{Transport: googleTransport(func(r *http.Request) (*http.Response, error) {
			body := ""
			switch r.URL.String() {
			case "https://oauth2.googleapis.com/token":
				_ = r.ParseForm()
				verifier = r.Form.Get("code_verifier")
				if r.Form.Get("client_secret") != "private-secret" || r.Form.Get("grant_type") != "authorization_code" {
					t.Fatal("invalid token exchange")
				}
				body = `{"access_token":"google-private-token","token_type":"Bearer"}`
			case "https://openidconnect.googleapis.com/v1/userinfo":
				if r.Header.Get("Authorization") != "Bearer google-private-token" {
					t.Fatal("missing backchannel authentication")
				}
				raw, _ := json.Marshal(map[string]any{"sub": "stable-user", "email": "same@example.com", "email_verified": verified, "name": "Google User"})
				body = string(raw)
			default:
				t.Fatal("unexpected request", r.URL)
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
		})}
		start := request(t, s, "POST", "/v1/auth/google/start", "", `{}`)
		var started map[string]string
		_ = json.Unmarshal(start.Body.Bytes(), &started)
		authorize, _ := url.Parse(started["authorization_url"])
		if authorize.Query().Get("scope") != "openid email profile" || authorize.Query().Get("prompt") != "select_account" || strings.Contains(start.Body.String(), "private-secret") {
			t.Fatal("invalid authorization")
		}
		handoff, _ := json.Marshal(map[string]string{"state": started["state"], "poll_token": started["poll_token"]})
		if got := request(t, s, "POST", "/v1/auth/google/poll", "", string(handoff)); got.Code != 202 {
			t.Fatal("expected pending")
		}
		bad, _ := json.Marshal(map[string]string{"state": started["state"], "poll_token": "wrong"})
		if got := request(t, s, "POST", "/v1/auth/google/poll", "", string(bad)); got.Code != 401 {
			t.Fatal("unauthorized polling")
		}
		callback := "/v1/auth/google/callback?state=" + started["state"] + "&code=code"
		got := request(t, s, "GET", callback, "", "")
		if verified && got.Code != 200 || !verified && got.Code != 400 {
			t.Fatal("verification result", got.Code)
		}
		digest := sha256.Sum256([]byte(verifier))
		if authorize.Query().Get("code_challenge") != base64.RawURLEncoding.EncodeToString(digest[:]) {
			t.Fatal("PKCE mismatch")
		}
		if replay := request(t, s, "GET", callback, "", ""); replay.Code != 400 {
			t.Fatal("callback replay")
		}
		got = request(t, s, "POST", "/v1/auth/google/poll", "", string(handoff))
		if !verified {
			if got.Code != 400 {
				t.Fatal("unverified identity accepted")
			}
			continue
		}
		if got.Code != 200 || strings.Contains(got.Body.String(), "google-private-token") {
			t.Fatal("provider token leaked")
		}
		var session struct {
			Token string `json:"session_token"`
		}
		_ = json.Unmarshal(got.Body.Bytes(), &session)
		if claims, err := s.sessions.Verify(session.Token); err != nil || claims.Subject != "google_stable-user" {
			t.Fatal("invalid app session", err)
		}
		if replay := request(t, s, "POST", "/v1/auth/google/poll", "", string(handoff)); replay.Code != 401 {
			t.Fatal("handoff replay")
		}
	}
}
func TestGoogleExpiryDenialAndEmailRemoval(t *testing.T) {
	s := newTestServer(store.NewMemory())
	s.google.entries["expired"] = &oauthAttempt{expires: time.Now().Add(-time.Minute)}
	s.google.entries["denied"] = &oauthAttempt{expires: time.Now().Add(time.Minute)}
	for _, path := range []string{"/v1/auth/google/callback?state=expired", "/v1/auth/google/callback?state=missing", "/v1/auth/google/callback?state=denied&error=access_denied"} {
		if got := request(t, s, "GET", path, "", ""); got.Code != 400 {
			t.Fatal("invalid callback accepted")
		}
	}
	if got := request(t, s, "POST", "/v1/auth/email/start", "", `{}`); got.Code != 404 {
		t.Fatal("obsolete email endpoint enabled")
	}
}
