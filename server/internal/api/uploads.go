package api

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"

	"foreman/internal/runner"
)

const maxUpload = 10 << 20

// upload keeps an image pasted or attached to a text (description, comment, request)
// and answers the address that goes into the markdown. The body is the file itself; the
// type comes from the content, not from what the browser says.
func (a *API) upload(w http.ResponseWriter, r *http.Request) (any, error) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxUpload+1))
	if err != nil || len(data) > maxUpload {
		return nil, bad("the image is larger than 10 MB")
	}
	ext := runner.UploadExt(http.DetectContentType(data))
	if ext == "" {
		return nil, bad("only PNG, JPEG, GIF or WebP images")
	}
	b := make([]byte, 16)
	rand.Read(b)
	name := hex.EncodeToString(b) + "." + ext
	dir := a.run.UploadDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		return nil, err
	}
	return map[string]string{"url": "/api/uploads/" + name}, nil
}

func (a *API) serveUpload(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !runner.UploadName.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	// The name never changes content: it can stay cached.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, filepath.Join(a.run.UploadDir(), name))
}
