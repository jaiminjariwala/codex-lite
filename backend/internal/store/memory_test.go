package store

import (
	"testing"
	"time"

	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/domain"
)

func TestUsageAndAccountLifecycle(t *testing.T) {
	data := NewMemory()
	user, err := data.UpsertGitHubUser(domain.User{GitHubID: 42, Login: "jaimin"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 29, 0, 0, 0, 0, time.UTC)
	usage, err := data.ChargeUsage(user.ID, 30, 100, now)
	if err != nil || usage.RemainingUnits != 70 || usage.Plan != domain.PlanFree {
		t.Fatalf("unexpected free usage: %#v, %v", usage, err)
	}
	usage, err = data.Usage(user.ID, 100, now)
	if err != nil || usage.Plan != domain.PlanFree || usage.LimitUnits != 100 {
		t.Fatalf("unexpected usage: %#v, %v", usage, err)
	}
	if _, err := data.ChargeUsage(user.ID, 71, 100, now); err == nil {
		t.Fatal("usage beyond the allowance was accepted")
	}

}
