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

	"multica/internal/api"
	"multica/internal/config"
	"multica/internal/db"
	"multica/internal/hub"
	"multica/internal/notify"
	"multica/internal/runner"
	"multica/internal/store"
	"multica/internal/webui"
)

func main() {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		log.Fatalf("pasta de dados: %v", err)
	}
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatalf("migrações: %v", err)
	}

	st := store.New(pool)
	h := hub.New()
	rn := runner.New(cfg, st, h)
	rn.Start(ctx)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Router(cfg, st, h, rn, notify.New(st), webui.Handler()),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	log.Printf("Multica em %s (dados em %s, %d execuções em paralelo)", cfg.Addr, cfg.DataDir, cfg.MaxParallel)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
