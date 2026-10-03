package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/domain"
)

// Google credentials never leave the server. State and PKCE bind the browser
// authorization to a one-time desktop handoff protected by a separate secret.
func (s *Server) googleStart(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.config.GoogleClientID == "" || s.config.GoogleClientSecret == "" || s.config.GoogleRedirectURL == "" {
		writeError(w, 503, "Google sign-in is not configured yet. Continue with GitHub.")
		return
	}
	state, poll, verifier := randomKey(), randomKey(), randomKey()
	s.google.Lock()
	for key, item := range s.google.entries {
		if time.Now().After(item.expires) {
			delete(s.google.entries, key)
		}
	}
	if len(s.google.entries) >= 1000 {
		s.google.Unlock()
		writeError(w, 429, "Too many pending sign-ins. Try again shortly.")
		return
	}
	s.google.entries[state] = &oauthAttempt{verifier: verifier, expires: time.Now().Add(10 * time.Minute), pollHash: sha256.Sum256([]byte(poll))}
	s.google.Unlock()
	digest := sha256.Sum256([]byte(verifier))
	query := url.Values{"client_id": {s.config.GoogleClientID}, "redirect_uri": {s.config.GoogleRedirectURL}, "response_type": {"code"}, "scope": {"openid email profile"}, "state": {state}, "code_challenge": {base64.RawURLEncoding.EncodeToString(digest[:])}, "code_challenge_method": {"S256"}, "prompt": {"select_account"}}
	writeJSON(w, 200, map[string]string{"authorization_url": "https://accounts.google.com/o/oauth2/v2/auth?" + query.Encode(), "state": state, "poll_token": poll})
}

func (s *Server) googleIdentity(r *http.Request, code, verifier string) (domain.User, error) {
	client := s.config.AuthHTTPClient
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	values := url.Values{"client_id": {s.config.GoogleClientID}, "client_secret": {s.config.GoogleClientSecret}, "redirect_uri": {s.config.GoogleRedirectURL}, "code": {code}, "code_verifier": {verifier}, "grant_type": {"authorization_code"}}
	req, err := http.NewRequestWithContext(r.Context(), "POST", "https://oauth2.googleapis.com/token", strings.NewReader(values.Encode()))
	if err != nil {
		return domain.User{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := client.Do(req)
	if err != nil {
		return domain.User{}, err
	}
	var token struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&token)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || token.AccessToken == "" || !strings.EqualFold(token.TokenType, "Bearer") {
		return domain.User{}, errors.New("Google token exchange failed")
	}
	// Read identity from Google's authenticated backchannel, never from desktop
	// claims or an unverified decoded JWT. ID tokens are not used as credentials.
	req, err = http.NewRequestWithContext(r.Context(), "GET", "https://openidconnect.googleapis.com/v1/userinfo", nil)
	if err != nil {
		return domain.User{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	response, err = client.Do(req)
	if err != nil {
		return domain.User{}, err
	}
	var identity struct {
		Sub      string `json:"sub"`
		Email    string `json:"email"`
		Verified bool   `json:"email_verified"`
		Name     string `json:"name"`
		Picture  string `json:"picture"`
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&identity)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || identity.Sub == "" || len(identity.Sub) > 255 || identity.Email == "" || !identity.Verified {
		return domain.User{}, errors.New("Google did not verify this identity")
	}
	return domain.User{ID: "google_" + identity.Sub, Email: identity.Email, Name: identity.Name, AvatarURL: identity.Picture}, nil
}

func (s *Server) googleCallback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	state := r.URL.Query().Get("state")
	s.google.Lock()
	item := s.google.entries[state]
	if item == nil || time.Now().After(item.expires) || item.claimed {
		s.google.Unlock()
		http.Error(w, "Sign-in expired. Return to Codex Lite and try again.", 400)
		return
	}
	item.claimed = true
	verifier := item.verifier
	s.google.Unlock()
	var result []byte
	if r.URL.Query().Get("error") == "" && r.URL.Query().Get("code") != "" {
		identity, err := s.googleIdentity(r, r.URL.Query().Get("code"), verifier)
		if err == nil {
			user, err := s.store.UpsertGoogleUser(identity)
			if err == nil {
				ttl := 30 * 24 * time.Hour
				token, err := s.sessions.Issue(user.ID, ttl)
				if err == nil {
					result, _ = json.Marshal(map[string]any{"session_token": token, "expires_at": time.Now().UTC().Add(ttl), "user": user})
				}
			}
		}
	}
	s.google.Lock()
	item.verifier = ""
	if len(result) == 0 {
		item.failure = "Google sign-in could not finish. Return to Codex Lite and try again."
	} else {
		item.token = string(result)
	}
	s.google.Unlock()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if len(result) == 0 {
		http.Error(w, "Google sign-in could not finish. Return to Codex Lite and try again.", 400)
		return
	}
	_, _ = io.WriteString(w, "You're signed in. You can close this tab and return to Codex Lite.")
}

func (s *Server) googlePoll(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var input struct {
		State     string `json:"state"`
		PollToken string `json:"poll_token"`
	}
	if decodeJSON(w, r, &input, 4096) != nil {
		writeError(w, 400, "Invalid sign-in request")
		return
	}
	s.google.Lock()
	defer s.google.Unlock()
	item := s.google.entries[input.State]
	if item == nil || time.Now().After(item.expires) || item.pollHash != sha256.Sum256([]byte(input.PollToken)) {
		writeError(w, 401, "Sign-in expired or invalid")
		return
	}
	if item.failure != "" {
		delete(s.google.entries, input.State)
		writeError(w, 400, item.failure)
		return
	}
	if item.token == "" {
		writeJSON(w, 202, map[string]string{"status": "pending"})
		return
	}
	delete(s.google.entries, input.State)
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, item.token)
}
