package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jaiminjariwala5/computer-browser-use/backend/internal/domain"
)

const schema = `
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    github_id BIGINT UNIQUE,
    login TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'plus')),
    used_units BIGINT NOT NULL DEFAULT 0 CHECK (used_units >= 0),
    usage_period_start TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Additive migration only. Old billing columns are left unused, not deleted.
ALTER TABLE users ALTER COLUMN github_id DROP NOT NULL;
`

type Postgres struct {
	pool *pgxpool.Pool
}

func NewPostgres(ctx context.Context, databaseURL string) (*Postgres, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	if _, err := pool.Exec(ctx, schema); err != nil {
		pool.Close()
		return nil, fmt.Errorf("apply postgres schema: %w", err)
	}
	return &Postgres{pool: pool}, nil
}

func (p *Postgres) Close() { p.pool.Close() }

func (p *Postgres) UpsertGitHubUser(input domain.User) (domain.User, error) {
	if input.ID == "" {
		input.ID = fmt.Sprintf("gh_%d", input.GitHubID)
	}
	row := p.pool.QueryRow(context.Background(), `
        INSERT INTO users (id, github_id, login, name, email, avatar_url, usage_period_start)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (github_id) DO UPDATE SET
            login = EXCLUDED.login,
            name = EXCLUDED.name,
            email = EXCLUDED.email,
            avatar_url = EXCLUDED.avatar_url,
            updated_at = NOW()
        RETURNING id, COALESCE(github_id, 0), login, name, email, avatar_url, plan,
            used_units, usage_period_start`,
		input.ID, input.GitHubID, input.Login, input.Name, input.Email, input.AvatarURL, monthStart(time.Now().UTC()))
	return scanUser(row)
}

func (p *Postgres) UpsertGoogleUser(input domain.User) (domain.User, error) {
	if input.ID == "" || input.Email == "" {
		return domain.User{}, errors.New("verified Google identity required")
	}
	_, err := p.pool.Exec(context.Background(), `
		INSERT INTO users (id, login, email, name, avatar_url, usage_period_start)
		VALUES ($1, $2, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, login = EXCLUDED.login, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, updated_at = NOW()
	`, input.ID, input.Email, input.Name, input.AvatarURL, monthStart(time.Now().UTC()))
	if err != nil {
		return domain.User{}, err
	}
	return p.UserByID(input.ID)
}

func (p *Postgres) UserByID(id string) (domain.User, error) {
	return scanUser(p.pool.QueryRow(context.Background(), userSelect+` WHERE id = $1`, id))
}

func (p *Postgres) ChargeUsage(userID string, units, limit int64, now time.Time) (domain.Usage, error) {
	if units < 0 {
		return domain.Usage{}, errors.New("usage limit exceeded")
	}
	tx, err := p.pool.BeginTx(context.Background(), pgx.TxOptions{})
	if err != nil {
		return domain.Usage{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	user, err := scanUser(tx.QueryRow(context.Background(), userSelect+` WHERE id = $1 FOR UPDATE`, userID))
	if err != nil {
		return domain.Usage{}, err
	}
	resetUsageIfNeeded(&user, now)
	if user.UsedUnits+units > limit {
		return domain.Usage{}, errors.New("usage limit exceeded")
	}
	user.UsedUnits += units
	if _, err := tx.Exec(context.Background(), `
        UPDATE users SET used_units = $2, usage_period_start = $3, updated_at = NOW()
        WHERE id = $1`, user.ID, user.UsedUnits, user.UsagePeriodStart); err != nil {
		return domain.Usage{}, err
	}
	if err := tx.Commit(context.Background()); err != nil {
		return domain.Usage{}, err
	}
	return usageFor(user, limit), nil
}

func (p *Postgres) Usage(userID string, limit int64, now time.Time) (domain.Usage, error) {
	tx, err := p.pool.BeginTx(context.Background(), pgx.TxOptions{})
	if err != nil {
		return domain.Usage{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	user, err := scanUser(tx.QueryRow(context.Background(), userSelect+` WHERE id = $1 FOR UPDATE`, userID))
	if err != nil {
		return domain.Usage{}, err
	}
	previousStart := user.UsagePeriodStart
	resetUsageIfNeeded(&user, now)
	if !user.UsagePeriodStart.Equal(previousStart) {
		if _, err := tx.Exec(context.Background(), `
            UPDATE users SET used_units = 0, usage_period_start = $2, updated_at = NOW()
            WHERE id = $1`, user.ID, user.UsagePeriodStart); err != nil {
			return domain.Usage{}, err
		}
	}
	if err := tx.Commit(context.Background()); err != nil {
		return domain.Usage{}, err
	}
	return usageFor(user, limit), nil
}

const userSelect = `SELECT id, COALESCE(github_id, 0), login, name, email, avatar_url, plan,
    used_units, usage_period_start FROM users`

type rowScanner interface {
	Scan(...any) error
}

func scanUser(row rowScanner) (domain.User, error) {
	var user domain.User
	err := row.Scan(&user.ID, &user.GitHubID, &user.Login, &user.Name, &user.Email,
		&user.AvatarURL, &user.Plan, &user.UsedUnits, &user.UsagePeriodStart)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.User{}, ErrNotFound
	}
	return user, err
}
