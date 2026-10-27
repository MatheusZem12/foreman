// Package config lê a configuração do ambiente. Tudo tem padrão: para subir
// basta DATABASE_URL.
package config

import (
	"os"
	"path/filepath"
	"strconv"
)

type Config struct {
	Addr         string // endereço HTTP
	DatabaseURL  string
	DataDir      string // repositórios, worktrees, skills materializadas
	MaxParallel  int    // execuções de agente simultâneas
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
	parallel, err := strconv.Atoi(env("MULTICA_MAX_PARALLEL", "3"))
	if err != nil || parallel < 1 {
		parallel = 3
	}
	data, _ := filepath.Abs(env("MULTICA_DATA", "./data"))
	return Config{
		Addr:         env("MULTICA_ADDR", "127.0.0.1:8700"),
		DatabaseURL:  env("DATABASE_URL", "postgres://multica:multica@localhost:5432/multica?sslmode=disable"),
		DataDir:      data,
		MaxParallel:  parallel,
		ClaudeBin:    env("CLAUDE_BIN", "claude"),
		CodexBin:     env("CODEX_BIN", "codex"),
		SecureCookie: env("MULTICA_SECURE_COOKIE", "false") == "true",
	}
}

func (c Config) Path(parts ...string) string {
	return filepath.Join(append([]string{c.DataDir}, parts...)...)
}
