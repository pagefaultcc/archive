package httpx

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
)

// APIError is the one error envelope used everywhere.
type APIError struct {
	Status     int               `json:"-"`
	Code       string            `json:"code"`
	Message    string            `json:"message"`
	Fields     map[string]string `json:"fields,omitempty"`
	RetryAfter int               `json:"-"`
}

func (e *APIError) Error() string { return e.Code }

// Stable code/message pairs.
var (
	InvalidRequest         = &APIError{Status: 400, Code: "invalid_request", Message: "Check the submitted fields."}
	InvalidCredentials     = &APIError{Status: 401, Code: "invalid_credentials", Message: "Invalid username or password."}
	Unauthenticated        = &APIError{Status: 401, Code: "unauthenticated", Message: "Authentication required."}
	Forbidden              = &APIError{Status: 403, Code: "forbidden", Message: "You do not have permission to perform this action."}
	BodyTooLarge           = &APIError{Status: 413, Code: "body_too_large", Message: "Request body is too large."}
	UnsupportedMediaType   = &APIError{Status: 415, Code: "unsupported_media_type", Message: "Content-Type must be application/json."}
	UsernameTaken          = &APIError{Status: 409, Code: "username_taken", Message: "That username is already in use."}
	RoleConflict           = &APIError{Status: 409, Code: "role_conflict", Message: "The requested change conflicts with the current state."}
	ImmutableTarget        = &APIError{Status: 409, Code: "immutable_target", Message: "This resource cannot be modified."}
	NotFound               = &APIError{Status: 404, Code: "not_found", Message: "Resource not found."}
	AuthenticationBusy     = &APIError{Status: 429, Code: "authentication_busy", Message: "Authentication is temporarily busy. Try again."}
	ServiceUnavailable     = &APIError{Status: 503, Code: "service_unavailable", Message: "Service temporarily unavailable."}
	InternalServerError    = &APIError{Status: 500, Code: "internal_error", Message: "An unexpected error occurred."}
	// Archive-specific codes.
	InvalidArchiveFormat   = &APIError{Status: 400, Code: "invalid_archive_format", Message: "Only .zip, .7z, and .rar archives are allowed."}
	InvalidArchivePassword = &APIError{Status: 422, Code: "invalid_archive_password", Message: "Incorrect password for this encrypted archive."}
	ErrUnsupportedMimeType = errors.New("unsupported media type")
	ErrBodyTooLarge        = errors.New("body too large")
)

// WithFields clones a validation error carrying per-field messages.
func WithFields(fields map[string]string) *APIError {
	e := *InvalidRequest
	e.Fields = fields
	return &e
}

// withRetryAfter clones an error response carrying a Retry-After hint.
func withRetryAfter(e *APIError) *APIError {
	c := *e
	c.RetryAfter = 2
	return &c
}

type envelope struct {
	Error *APIError `json:"error"`
}

// WriteJSON emits a success payload with no-store caching.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteError emits the single error envelope.
func WriteError(w http.ResponseWriter, err *APIError) {
	if err.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(err.RetryAfter))
	}
	WriteJSON(w, err.Status, envelope{Error: err})
}

// WriteRawStatus emits a bare status with no body (204 etc.).
func WriteNoContent(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
