package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"foreman/internal/config"
	"foreman/internal/runner"
)

func TestUploadAndServe(t *testing.T) {
	a := &API{run: runner.New(config.Config{DataDir: t.TempDir()}, nil, nil)}
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 32)...)

	res, err := a.upload(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/uploads", bytes.NewReader(png)))
	if err != nil {
		t.Fatal(err)
	}
	url := res.(map[string]string)["url"]
	name := strings.TrimPrefix(url, "/api/uploads/")
	if !runner.UploadName.MatchString(name) || !strings.HasSuffix(name, ".png") {
		t.Fatalf("unexpected address %q", url)
	}

	serve := func(n string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/uploads/"+n, nil)
		rc := chi.NewRouteContext()
		rc.URLParams.Add("name", n)
		w := httptest.NewRecorder()
		a.serveUpload(w, req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc)))
		return w
	}
	if w := serve(name); w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), png) || w.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("serve: %d %q", w.Code, w.Header().Get("Content-Type"))
	}
	if w := serve("..%2f..%2fetc%2fpasswd"); w.Code != http.StatusNotFound {
		t.Fatalf("a name outside the pattern should be 404, got %d", w.Code)
	}

	// Not an image: refused, whatever the browser claims.
	req := httptest.NewRequest("POST", "/api/uploads", strings.NewReader("<script>alert(1)</script>"))
	req.Header.Set("Content-Type", "image/png")
	if _, err := a.upload(httptest.NewRecorder(), req); err == nil {
		t.Fatal("a non-image was accepted")
	}
}
