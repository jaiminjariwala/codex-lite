package domain

import "time"

type Plan string

const (
	PlanFree Plan = "free"
)

type User struct {
	ID               string    `json:"id"`
	GitHubID         int64     `json:"github_id"`
	Login            string    `json:"login"`
	Name             string    `json:"name"`
	Email            string    `json:"email,omitempty"`
	AvatarURL        string    `json:"avatar_url,omitempty"`
	Plan             Plan      `json:"plan"`
	UsedUnits        int64     `json:"used_units"`
	UsagePeriodStart time.Time `json:"usage_period_start"`
}

type Usage struct {
	Plan           Plan      `json:"plan"`
	UsedUnits      int64     `json:"used_units"`
	LimitUnits     int64     `json:"limit_units"`
	RemainingUnits int64     `json:"remaining_units"`
	ResetsAt       time.Time `json:"resets_at"`
}
