package httpx

import (
	"archive/backend/internal/auth"
)

func defaultHashPassword(pw []byte) (string, error) {
	return auth.Hash(pw, auth.DefaultParams)
}
