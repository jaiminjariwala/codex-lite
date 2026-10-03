package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/ai"
	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/auth"
	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/config"
	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/httpapi"
	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	client := &http.Client{Timeout: 60 * time.Second}
	router := ai.NewRouter(
		ai.NewCompatibleProvider("gemini", "https://generativelanguage.googleapis.com/v1beta/openai", cfg.GeminiModel, cfg.GeminiAPIKey, client),
		ai.NewCompatibleProvider("openrouter", "https://openrouter.ai/api/v1", cfg.OpenRouterModel, cfg.OpenRouterAPIKey, client),
	)
	var data store.Store = store.NewMemory()
	var closeStore func()
	if cfg.DatabaseURL != "" {
		postgres, err := store.NewPostgres(context.Background(), cfg.DatabaseURL)
		if err != nil {
			logger.Error("postgres initialization failed", "error", err)
			os.Exit(1)
		}
		data = postgres
		closeStore = postgres.Close
		logger.Info("persistent store ready", "kind", "postgres")
	} else {
		logger.Warn("DATABASE_URL is empty; using non-persistent development storage")
	}
	if closeStore != nil {
		defer closeStore()
	}

	api := httpapi.New(httpapi.Config{
		GoogleClientID: cfg.GoogleClientID, GoogleClientSecret: cfg.GoogleClientSecret, GoogleRedirectURL: cfg.GoogleRedirectURL, AuthHTTPClient: client,
		GitHubClientID: cfg.GitHubClientID, GitHubClientSecret: cfg.GitHubClientSecret, GitHubRedirectURL: cfg.GitHubRedirectURL,
		PublicAppURL: cfg.PublicAppURL, FreeMonthlyUnits: cfg.FreeMonthlyUnits,
	}, auth.NewGitHub(client), auth.NewSessions(cfg.SessionSecret), data, router, logger)

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           api,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		logger.Info("backend listening", "address", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("backend stopped", "error", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}
