package config

import (
	"errors"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	GoogleClientID     string
	GoogleClientSecret string
	GoogleRedirectURL  string
	GitHubClientID     string
	GitHubClientSecret string
	GitHubRedirectURL  string
	Port               string
	DatabaseURL        string
	PublicAppURL       string
	SessionSecret      string
	GeminiAPIKey       string
	GeminiModel        string
	OpenRouterAPIKey   string
	OpenRouterModel    string
	OpenAIAPIKey       string
	OpenAICodexModel   string
	FreeMonthlyUnits   int64
}

func Load() (Config, error) {
	cfg := Config{
		GoogleClientID:     strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_CLIENT_ID")),
		GoogleClientSecret: strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_CLIENT_SECRET")),
		GoogleRedirectURL:  env("GOOGLE_OAUTH_REDIRECT_URL", "http://127.0.0.1:8787/v1/auth/google/callback"),
		GitHubClientID:     strings.TrimSpace(os.Getenv("GITHUB_OAUTH_CLIENT_ID")),
		GitHubClientSecret: strings.TrimSpace(os.Getenv("GITHUB_OAUTH_CLIENT_SECRET")),
		GitHubRedirectURL:  env("GITHUB_OAUTH_REDIRECT_URL", "http://127.0.0.1:8787/v1/auth/github/callback"),
		Port:               env("PORT", "8787"),
		DatabaseURL:        strings.TrimSpace(os.Getenv("DATABASE_URL")),
		PublicAppURL:       env("PUBLIC_APP_URL", "http://localhost:5173"),
		SessionSecret:      strings.TrimSpace(os.Getenv("SESSION_SECRET")),
		GeminiAPIKey:       strings.TrimSpace(os.Getenv("GEMINI_API_KEY")),
		GeminiModel:        env("GEMINI_MODEL", "gemini-2.5-flash"),
		OpenRouterAPIKey:   strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY")),
		OpenRouterModel:    env("OPENROUTER_MODEL", "openrouter/free"),
		OpenAIAPIKey:       strings.TrimSpace(os.Getenv("OPENAI_API_KEY")),
		OpenAICodexModel:   env("OPENAI_CODEX_MODEL", "gpt-5-codex"),
		FreeMonthlyUnits:   envInt64("FREE_MONTHLY_UNITS", 50_000),
	}
	if (cfg.GoogleClientID == "") != (cfg.GoogleClientSecret == "") {
		return Config{}, errors.New("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set together")
	}
	if len(cfg.SessionSecret) < 32 {
		return Config{}, errors.New("SESSION_SECRET must contain at least 32 characters")
	}
	for _, address := range []string{cfg.GitHubRedirectURL, cfg.GoogleRedirectURL} {
		if address == "" {
			continue
		}
		parsed, err := url.Parse(address)
		if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && !(parsed.Scheme == "http" && (parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "localhost"))) {
			return Config{}, errors.New("OAuth URLs require HTTPS, except localhost development")
		}
	}
	if cfg.OpenRouterModel != "openrouter/free" && !strings.HasSuffix(cfg.OpenRouterModel, ":free") {
		return Config{}, errors.New("OPENROUTER_MODEL must be openrouter/free or a :free model; paid fallback is disabled")
	}
	if cfg.FreeMonthlyUnits <= 0 {
		return Config{}, errors.New("monthly usage limits must be positive")
	}
	return cfg, nil
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envInt64(name string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}
