package config

import "testing"

func TestGoogleOAuthConfiguration(t *testing.T) {
	t.Setenv("SESSION_SECRET", "test-secret-at-least-thirty-two-characters")
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "client")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "")
	if _, err := Load(); err == nil {
		t.Fatal("partial OAuth credentials accepted")
	}
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "secret")
	for _, bad := range []string{"http://remote.example/callback", "https:/missing-host", "https://user:password@example.com/callback", "https://example.com/callback?secret=value"} {
		t.Setenv("GOOGLE_OAUTH_REDIRECT_URL", bad)
		if _, err := Load(); err == nil {
			t.Fatal("unsafe callback accepted", bad)
		}
	}
	t.Setenv("GOOGLE_OAUTH_REDIRECT_URL", "https://example.com/v1/auth/google/callback")
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
}
