package auth

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestLimiterAcquireRelease(t *testing.T) {
	l := NewLimiter(2)
	r1, err := l.Acquire(context.Background(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := l.Acquire(context.Background(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	// Third caller saturated.
	if _, err := l.Acquire(context.Background(), 50*time.Millisecond); !errors.Is(err, ErrBusy) {
		t.Fatalf("expected ErrBusy, got %v", err)
	}
	r1()
	r2()
	// Slot released: acquire works again.
	r3, err := l.Acquire(context.Background(), time.Second)
	if err != nil {
		t.Fatalf("after release: %v", err)
	}
	r3()
}

func TestLimiterCancellationQueued(t *testing.T) {
	l := NewLimiter(1)
	r1, _ := l.Acquire(context.Background(), time.Second)
	defer r1()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	if _, err := l.Acquire(ctx, 5*time.Second); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected ctx.Err, got %v", err)
	}
}

func TestLimiterNoDerivationWhenSaturated(t *testing.T) {
	l := NewLimiter(2)
	var derivations atomic.Int32
	limitingAcquire := func() {
		release, err := l.Acquire(context.Background(), 10*time.Millisecond)
		if err == nil {
			derivations.Add(1)
			time.Sleep(20 * time.Millisecond)
			release()
		}
	}
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() { defer wg.Done(); limitingAcquire() }()
	}
	wg.Wait()
	if derivations.Load() > 2 {
		t.Fatalf("concurrency exceeded capacity: %d", derivations.Load())
	}
}
