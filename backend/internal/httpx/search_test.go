package httpx_test

import (
	"encoding/json"
	"testing"
)

func TestBlankSearchBeforeDatabaseStatistics(t *testing.T) {
	a := newArchiveEnv(t)
	assertSearch := func(query string, wantTotal int64, wantRows int) {
		t.Helper()
		res := do(t, a.srv, "GET", "/api/search"+query, "", origin, a.cookie)
		if res.status != 200 {
			t.Fatalf("search: %d %s", res.status, res.body)
		}
		var body struct {
			Results    []json.RawMessage `json:"results"`
			TotalCount int64             `json:"totalCount"`
		}
		if err := json.Unmarshal(res.body, &body); err != nil {
			t.Fatal(err)
		}
		if body.TotalCount != wantTotal || len(body.Results) != wantRows {
			t.Fatalf("search %q: total=%d rows=%d, want total=%d rows=%d", query, body.TotalCount, len(body.Results), wantTotal, wantRows)
		}
	}

	// A newly migrated table has no planner estimate yet, not a negative count.
	assertSearch("", 0, 0)
	res := a.upload(t, "statistics.zip", makeZip(t, map[string]string{
		"docs/one.txt": "one",
		"docs/two.txt": "two",
	}), "")
	if res.status != 201 {
		t.Fatalf("upload: %d %s", res.status, res.body)
	}
	// Count files, not directories or just the current page's rows.
	assertSearch("?limit=1&offset=1", 2, 1)
}
