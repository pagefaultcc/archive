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

	"archive/backend/internal/bootstrap"
	"archive/backend/internal/config"
	"archive/backend/internal/httpx"
	"archive/backend/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg, err := config.Load()
	if err != nil {
		log.Error("configuration error", "error", err.Error())
		os.Exit(1)
	}

	ctx, stop := signalContext()
	defer stop()

	// One dedicated session for migrations + bootstrap under advisory lock.
	created, err := bootstrap.Run(ctx, cfg.DatabaseURL, bootstrap.Options{
		RootUsername: cfg.RootUsername,
		RootPassword: cfg.RootPassword,
	})
	if err != nil {
		log.Error("bootstrap failed", "error", err.Error())
		os.Exit(1)
	}
	if created {
		log.Info("root user bootstrapped")
	}

	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("database pool failed", "error", err.Error())
		os.Exit(1)
	}
	defer st.Close()

	if _, err := st.DeleteExpiredSessions(ctx); err != nil {
		log.Error("startup session cleanup failed", "error", err.Error())
		os.Exit(1)
	}
	cleanupCtx, cleanupStop := context.WithCancel(ctx)
	defer cleanupStop()
	go cleanupLoop(cleanupCtx, st, log)

	handler := httpx.NewRouter(st, cfg.PublicOrigin, log)
	srv := httpx.NewServer(cfg.Addr, handler)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	log.Info("api listening", "addr", cfg.Addr)

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server error", "error", err.Error())
		}
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	cleanupStop()
	log.Info("api stopped")
}

func cleanupLoop(ctx context.Context, st *store.Store, log *slog.Logger) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := st.DeleteExpiredSessions(ctx); err != nil {
				log.Error("periodic session cleanup failed", "error", err.Error())
			}
		}
	}
}

func signalContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-ch
		cancel()
	}()
	return ctx, cancel
}
