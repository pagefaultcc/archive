package httpx

import (
	"crypto/rand"
	"time"
)

func timeNow() time.Time { return time.Now() }

func randRead(b []byte) (int, error) { return rand.Read(b) }
