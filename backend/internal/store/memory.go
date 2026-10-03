package store

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/domain"
)

var ErrNotFound = errors.New("not found")

type Store interface {
	UpsertGitHubUser(user domain.User) (domain.User, error)
	UpsertGoogleUser(user domain.User) (domain.User, error)
	UserByID(id string) (domain.User, error)
	ChargeUsage(userID string, units, limit int64, now time.Time) (domain.Usage, error)
	Usage(userID string, limit int64, now time.Time) (domain.Usage, error)
}

type Memory struct {
	mu           sync.Mutex
	users        map[string]domain.User
	githubToUser map[int64]string
}

func NewMemory() *Memory {
	return &Memory{
		users:        make(map[string]domain.User),
		githubToUser: make(map[int64]string),
	}
}

func (m *Memory) UpsertGitHubUser(input domain.User) (domain.User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.githubToUser[input.GitHubID]; ok {
		existing := m.users[id]
		existing.Login, existing.Name, existing.Email, existing.AvatarURL = input.Login, input.Name, input.Email, input.AvatarURL
		m.users[id] = existing
		return existing, nil
	}
	if input.ID == "" {
		input.ID = fmt.Sprintf("gh_%d", input.GitHubID)
	}
	input.Plan = domain.PlanFree
	input.UsagePeriodStart = monthStart(time.Now().UTC())
	m.users[input.ID] = input
	m.githubToUser[input.GitHubID] = input.ID
	return input, nil
}

func (m *Memory) UpsertGoogleUser(input domain.User) (domain.User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if input.ID == "" || input.Email == "" {
		return domain.User{}, errors.New("verified Google identity required")
	}
	if existing, ok := m.users[input.ID]; ok {
		existing.Email, existing.Login, existing.Name, existing.AvatarURL = input.Email, input.Email, input.Name, input.AvatarURL
		m.users[input.ID] = existing
		return existing, nil
	}
	input.Login, input.Plan = input.Email, domain.PlanFree
	input.UsagePeriodStart = monthStart(time.Now().UTC())
	m.users[input.ID] = input
	return input, nil
}

func (m *Memory) UserByID(id string) (domain.User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	user, ok := m.users[id]
	if !ok {
		return domain.User{}, ErrNotFound
	}
	return user, nil
}

func (m *Memory) ChargeUsage(userID string, units, limit int64, now time.Time) (domain.Usage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	user, ok := m.users[userID]
	if !ok {
		return domain.Usage{}, ErrNotFound
	}
	resetUsageIfNeeded(&user, now)
	if units < 0 || user.UsedUnits+units > limit {
		return domain.Usage{}, errors.New("usage limit exceeded")
	}
	user.UsedUnits += units
	m.users[userID] = user
	return usageFor(user, limit), nil
}

func (m *Memory) Usage(userID string, limit int64, now time.Time) (domain.Usage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	user, ok := m.users[userID]
	if !ok {
		return domain.Usage{}, ErrNotFound
	}
	resetUsageIfNeeded(&user, now)
	m.users[userID] = user
	return usageFor(user, limit), nil
}

func resetUsageIfNeeded(user *domain.User, now time.Time) {
	start := monthStart(now.UTC())
	if user.UsagePeriodStart.IsZero() || user.UsagePeriodStart.Before(start) {
		user.UsagePeriodStart = start
		user.UsedUnits = 0
	}
}

func monthStart(now time.Time) time.Time {
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

func usageFor(user domain.User, limit int64) domain.Usage {
	remaining := limit - user.UsedUnits
	if remaining < 0 {
		remaining = 0
	}
	return domain.Usage{
		Plan:           domain.PlanFree,
		UsedUnits:      user.UsedUnits,
		LimitUnits:     limit,
		RemainingUnits: remaining,
		ResetsAt:       user.UsagePeriodStart.AddDate(0, 1, 0),
	}
}
