package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"foreman/internal/api"
	"foreman/internal/automation"
	"foreman/internal/config"
	"foreman/internal/db"
	"foreman/internal/hub"
	"foreman/internal/notify"
	"foreman/internal/runner"
	"foreman/internal/store"
	"foreman/internal/webui"
)

func main() {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		log.Fatalf("data folder: %v", err)
	}
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatalf("migrations: %v", err)
	}

	st := store.New(pool)
	h := hub.New()
	rn := runner.New(cfg, st, h)
	ntf := notify.New(st)
	automation.New(st, rn, ntf).Start(ctx) // workflow rules: issue events + a sweep over time
	rn.Start(ctx)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Router(cfg, st, h, rn, ntf, webui.Handler()),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	log.Printf("Foreman on %s (data in %s, %d parallel runs)", cfg.Addr, cfg.DataDir, cfg.MaxParallel)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
