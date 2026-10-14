package httpx

import (
	"context"
	"log/slog"
	"net/http"

	"archive/backend/internal/auth"
	"archive/backend/internal/config"
	"archive/backend/internal/store"
)

// NewRouter wires routes, origin validation, session and permission
// middleware, logging, and bounded server configuration.
func NewRouter(st *store.Store, origin *config.URL, log *slog.Logger) http.Handler {
	lim := auth.NewLimiter(2)
	authH := NewAuthHandlers(st, lim, origin, origin.Scheme == "https", log)
	users := &userHandlers{Store: st, Limiter: lim}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		if err := st.Ping(r.Context()); err != nil {
			log.Error("readiness ping failed", "error", err.Error())
			WriteError(w, ServiceUnavailable)
			return
		}
		WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.Handle("POST /api/auth/login", RequireOrigin(origin, http.HandlerFunc(authH.Login)))
	mux.Handle("POST /api/auth/logout", RequireOrigin(origin, http.HandlerFunc(authH.Logout)))

	// guarded registers a method-aware route that requires a session, the
	// given permission, and a valid Origin.
	guarded := func(method, pattern, permission string, h http.HandlerFunc) {
		mux.Handle(method+" "+pattern, RequireOrigin(origin, authH.SessionMiddleware(
			authH.RequirePermission(permission, h))))
	}

	// me (no permission).
	mux.Handle("GET /api/auth/me", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(authH.Me))))

	// Archives: any authenticated active session may list, upload, browse,
	// and unlock; deletion additionally requires ownership or a delete
	archives := newArchiveHandlers(st, log)
	channels := newChannelHandlers(st, log)
	archives.startSweeper(context.Background())
	mux.Handle("GET /api/archives", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.list))))
	mux.Handle("POST /api/archives", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.upload))))
	mux.Handle("POST /api/archives/reindex", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.reindexAll))))
	mux.Handle("GET /api/archives/{id}", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.get))))
	mux.Handle("GET /api/archives/{id}/file", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.filePreview))))
	mux.Handle("GET /api/archives/{id}/download", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.downloadEntry))))
	mux.Handle("POST /api/archives/{id}/unlock", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.unlock))))
	mux.Handle("POST /api/archives/{id}/reindex", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.reindexOne))))
	mux.Handle("DELETE /api/archives/{id}", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.delete))))
	mux.Handle("GET /api/settings/storage", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.storageStats))))
	mux.Handle("POST /api/settings/cleanup-temp", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.cleanupTemp))))
	mux.Handle("GET /api/settings/passwords", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.getArchivePasswords))))
	mux.Handle("PUT /api/settings/passwords", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.updateArchivePasswords))))
	mux.Handle("POST /api/settings/reindex-cookies", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.reindexAllCookies))))
	mux.Handle("GET /api/cookies", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.listCookies))))
	mux.Handle("GET /api/cookies/download", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.downloadCookies))))
	mux.Handle("GET /api/search", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.searchEntries))))
	mux.Handle("GET /api/search/download", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.downloadSearchResults))))
	mux.Handle("POST /api/search/prepare-download", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.prepareSearchDownload))))
	mux.Handle("GET /api/search/download-job/{id}", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.getSearchDownloadJob))))
	mux.Handle("GET /api/search/download-job/{id}/file", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(archives.serveSearchDownloadFile))))

	// Channels & Auto-Scrape.
	mux.Handle("GET /api/channels/settings", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.getSettings))))
	mux.Handle("PUT /api/channels/settings", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.updateSettings))))
	mux.Handle("POST /api/channels/test-connection", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.testConnection))))
	mux.Handle("GET /api/channels", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.list))))
	mux.Handle("POST /api/channels", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.create))))
	mux.Handle("PUT /api/channels/{id}", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.update))))
	mux.Handle("DELETE /api/channels/{id}", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.delete))))
	mux.Handle("POST /api/channels/test-script", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.testScript))))
	mux.Handle("POST /api/channels/scrape", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.scrape))))
	mux.Handle("POST /api/channels/import", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.importFiles))))
	mux.Handle("DELETE /api/channels/blacklist", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.clearBlacklist))))
	mux.Handle("POST /api/channels/queue", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.enqueueBatch))))
	mux.Handle("GET /api/channels/queue", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.getQueueStatus))))
	mux.Handle("DELETE /api/channels/queue", RequireOrigin(origin, authH.SessionMiddleware(http.HandlerFunc(channels.clearQueue))))
	// Users.
	mux.Handle("GET /api/users", RequireOrigin(origin, authH.SessionMiddleware(
		authH.RequirePermission("users:read", users.list))))
	mux.Handle("POST /api/users", RequireOrigin(origin, authH.SessionMiddleware(
		authH.RequirePermission("users:create", users.create))))
	guarded("GET", "/api/users/{id}", "users:read", users.get)
	guarded("PATCH", "/api/users/{id}", "users:update", users.updateUsername)
	guarded("DELETE", "/api/users/{id}", "users:delete", users.delete)
	guarded("PATCH", "/api/users/{id}/password", "users:update", users.resetPassword)
	guarded("PATCH", "/api/users/{id}/suspension", "users:update", users.suspend)
	guarded("POST", "/api/users/{id}/restore", "users:delete", users.restore)
	mux.Handle("GET /api/users/{id}/sessions", RequireOrigin(origin, authH.SessionMiddleware(
		authH.RequirePermission("users:manage_sessions", users.listSessions))))
	mux.Handle("DELETE /api/users/{id}/sessions", RequireOrigin(origin, authH.SessionMiddleware(
		authH.RequirePermission("users:manage_sessions", users.revokeAllSessions))))
	guarded("DELETE", "/api/users/{id}/sessions/{sid}", "users:manage_sessions", users.revokeSession)
	mux.Handle("PUT /api/users/{id}/roles/{roleId}", RequireOrigin(origin, authH.SessionMiddleware(
		authH.RequirePermission("users:manage_roles", users.assignRole))))
	mux.Handle("DELETE /api/users/{id}/roles/{roleId}", RequireOrigin(origin, authH.SessionMiddleware(
		authH.RequirePermission("users:manage_roles", users.removeRole))))

	// Roles and permissions.
	mux.Handle("GET /api/roles", RequireOrigin(origin, authH.SessionMiddleware(
		authH.RequirePermission("roles:read", users.listRoles))))
	mux.Handle("POST /api/roles", RequireOrigin(origin, authH.SessionMiddleware(
		authH.RequirePermission("roles:create", users.createRole))))
	guarded("PUT", "/api/roles/{roleId}", "roles:update", users.renameRole)
	guarded("DELETE", "/api/roles/{roleId}", "roles:delete", users.deleteRole)
	mux.Handle("GET /api/permissions", RequireOrigin(origin, authH.SessionMiddleware(
		authH.RequirePermission("roles:read", users.listPermissions))))
	mux.Handle("GET /api/audit", RequireOrigin(origin, authH.SessionMiddleware(
		authH.RequirePermission("audit:read", users.audit))))

	// Unknown paths under /api return 404 JSON; other methods are 405s.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, NotFound)
	})

	// Unknown paths outside /api return 404 JSON.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, &APIError{Status: 404, Code: "invalid_request", Message: "Resource not found."})
	})

	return RequestLogger(log, mux)
}

// NewServer builds the HTTP server with bounded timeouts.
func NewServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * 1e9,
		IdleTimeout:       60 * 1e9,
	}
}
