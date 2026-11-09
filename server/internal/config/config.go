// Package config reads the configuration from the environment. Everything has a default: to
// start, DATABASE_URL is enough.
package config

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type Config struct {
	Addr         string // HTTP address
	DatabaseURL  string
	DataDir      string        // repositories, worktrees, materialized skills
	MaxParallel  int           // simultaneous agent runs
	RunTimeout   time.Duration // a run that goes over it is killed (a hung agent can't hold a slot forever)
	ClaudeBin    string
	CodexBin     string
	SecureCookie bool
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func Load() Config {
	parallel, err := strconv.Atoi(env("FOREMAN_MAX_PARALLEL", "3"))
	if err != nil || parallel < 1 {
		parallel = 3
	}
	timeout, err := time.ParseDuration(env("FOREMAN_RUN_TIMEOUT", "4h"))
	if err != nil || timeout <= 0 {
		timeout = 4 * time.Hour
	}
	data, _ := filepath.Abs(env("FOREMAN_DATA", "./data"))
	return Config{
		Addr:         env("FOREMAN_ADDR", "127.0.0.1:8700"),
		DatabaseURL:  env("DATABASE_URL", "postgres://foreman:foreman@localhost:5432/foreman?sslmode=disable"),
		DataDir:      data,
		MaxParallel:  parallel,
		RunTimeout:   timeout,
		ClaudeBin:    env("CLAUDE_BIN", "claude"),
		CodexBin:     env("CODEX_BIN", "codex"),
		SecureCookie: env("FOREMAN_SECURE_COOKIE", "false") == "true",
	}
}

func (c Config) Path(parts ...string) string {
	return filepath.Join(append([]string{c.DataDir}, parts...)...)
}
