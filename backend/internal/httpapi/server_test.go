package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/ai"
	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/auth"
	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/domain"
	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/store"
)

type githubStub struct{}

func (githubStub) Verify(context.Context, string) (domain.User, error) {
	return domain.User{GitHubID: 42, Login: "jaimin", Name: "Jaimin", Email: "jaimin@example.com"}, nil
}

type aiStub struct{}

func (aiStub) Available() bool { return true }
func (aiStub) Complete(context.Context, ai.Request) (ai.Result, error) {
	return ai.Result{
		Provider: "gemini",
		Model:    "gemini-2.5-flash",
		Text:     "Hello from the managed service.",
		Usage:    ai.TokenUsage{InputTokens: 15, OutputTokens: 20, TotalTokens: 35},
	}, nil
}

func TestNoPaymentRequired(t *testing.T) {
	server := newTestServer(store.NewMemory())
	token := authenticate(t, server)
	for _, endpoint := range []string{"/v1/chat", "/v1/chat/completions"} {
		response := request(t, server, http.MethodPost, endpoint, token, `{"messages":[{"role":"user","content":"Hello"}]}`)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", endpoint, response.Code, response.Body.String())
		}
	}
	for _, endpoint := range []string{"/checkout", "/checkout/return", "/v1/billing/checkout", "/v1/billing/portal", "/v1/webhooks/stripe"} {
		response := request(t, server, http.MethodPost, endpoint, token, `{}`)
		if response.Code != http.StatusNotFound {
			t.Fatalf("removed route %s returned %d", endpoint, response.Code)
		}
	}
}

func TestAuthenticatedChat(t *testing.T) {
	data := store.NewMemory()
	server := newTestServer(data)

	unauthorized := httptest.NewRecorder()
	server.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/me", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d, want %d", unauthorized.Code, http.StatusUnauthorized)
	}

	token := authenticate(t, server)
	chat := request(t, server, http.MethodPost, "/v1/chat", token, `{"messages":[{"role":"user","content":"Hello"}]}`)
	if chat.Code != http.StatusOK {
		t.Fatalf("chat status = %d; body = %s", chat.Code, chat.Body.String())
	}
	var chatBody struct {
		Response ai.Result    `json:"response"`
		Usage    domain.Usage `json:"usage"`
	}
	decodeResponse(t, chat, &chatBody)
	if chatBody.Response.Provider != "gemini" || chatBody.Usage.UsedUnits != 35 || chatBody.Usage.RemainingUnits != 965 {
		t.Fatalf("unexpected chat response: %#v", chatBody)
	}

}

func TestOpenAICompatibleRouteAcceptsVisionMessages(t *testing.T) {
	data := store.NewMemory()
	server := newTestServer(data)
	token := authenticate(t, server)
	response := request(t, server, http.MethodPost, "/v1/chat/completions", token, `{
        "model":"managed-standard",
        "messages":[{"role":"user","content":[
            {"type":"text","text":"What is shown?"},
            {"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}
        ]}]
    }`)
	if response.Code != http.StatusOK {
		t.Fatalf("compatible chat response = %d %s", response.Code, response.Body.String())
	}
	var body struct {
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	decodeResponse(t, response, &body)
	if body.Model != "gemini-2.5-flash" || len(body.Choices) != 1 || body.Choices[0].Message.Content == "" {
		t.Fatalf("unexpected compatible response: %#v", body)
	}
}

func newTestServer(data store.Store) *Server {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(Config{PublicAppURL: "http://localhost:5173", FreeMonthlyUnits: 1_000},
		githubStub{}, auth.NewSessions("test-session-secret-with-at-least-32-characters"), data, aiStub{}, logger)
}

func authenticate(t *testing.T, server *Server) string {
	t.Helper()
	response := request(t, server, http.MethodPost, "/v1/auth/github", "", `{"access_token":"github-token"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("auth response = %d %s", response.Code, response.Body.String())
	}
	var body struct {
		SessionToken string `json:"session_token"`
	}
	decodeResponse(t, response, &body)
	if body.SessionToken == "" {
		t.Fatal("auth response did not contain a session token")
	}
	return body.SessionToken
}

func request(t *testing.T, server *Server, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	server.ServeHTTP(recorder, req)
	return recorder
}

func decodeResponse(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		t.Fatalf("decode response: %v; body = %s", err, response.Body.String())
	}
}
