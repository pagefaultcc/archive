package auth

import (
	"context"
	"errors"
	"time"
)

// ErrBusy reports the two-slot derivation semaphore saturated.
var ErrBusy = errors.New("derivation slots saturated")

// Limiter bounds all Argon2id derivations (real and dummy) to two
// concurrent slots. Waiting is bounded; saturated callers get ErrBusy.
type Limiter struct {
	sem chan struct{}
}

// NewLimiter returns a process-wide limiter with capacity n.
func NewLimiter(n int) *Limiter {
	return &Limiter{sem: make(chan struct{}, n)}
}

// Acquire blocks up to wait for a slot; ctx cancel or timeout releases the
// caller without holding a slot.
func (l *Limiter) Acquire(ctx context.Context, wait time.Duration) (release func(), err error) {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case l.sem <- struct{}{}:
		released := false
		return func() {
			if !released {
				released = true
				<-l.sem
			}
		}, nil
	case <-timer.C:
		return nil, ErrBusy
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
