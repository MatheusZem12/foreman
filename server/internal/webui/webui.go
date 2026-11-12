// Package webui embeds the front-end build (web/dist copied here).
package webui

import (
	"bytes"
	"compress/gzip"
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

//go:embed all:dist
var dist embed.FS

// Text files are sent gzipped (about a third of the size, which is what matters when
// Foreman is reached through a VPN or a tunnel). Each file is compressed once, on its
// first request, and kept in memory: the build is embedded and never changes.
var compressible = map[string]bool{".js": true, ".css": true, ".html": true, ".svg": true, ".json": true, ".webmanifest": true, ".txt": true}

var zipped sync.Map // path -> []byte

func gz(name string, raw []byte) []byte {
	if b, ok := zipped.Load(name); ok {
		return b.([]byte)
	}
	var buf bytes.Buffer
	w, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	w.Write(raw)
	w.Close()
	zipped.Store(name, buf.Bytes())
	return buf.Bytes()
}

// serve writes one embedded file, gzipped when the browser accepts it and it pays off.
func serve(w http.ResponseWriter, r *http.Request, name string, body []byte) {
	ext := path.Ext(name)
	ctype := mime.TypeByExtension(ext)
	if ext == ".webmanifest" {
		ctype = "application/manifest+json"
	}
	if ctype == "" {
		ctype = http.DetectContentType(body)
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	if compressible[ext] {
		h.Add("Vary", "Accept-Encoding")
		if len(body) > 1024 && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			body = gz(name, body)
			h.Set("Content-Encoding", "gzip")
		}
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodHead {
		return
	}
	w.Write(body)
}

// Handler serves the static files and returns index.html for any unknown route
// (routing happens on the client side).
func Handler() http.Handler {
	sub, _ := fs.Sub(dist, "dist")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name != "" && name != "index.html" {
			if info, err := fs.Stat(sub, name); err == nil && !info.IsDir() {
				if body, err := fs.ReadFile(sub, name); err == nil {
					if strings.HasPrefix(name, "assets/") {
						// The file name carries a hash of its content: it never changes.
						w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
					} else {
						w.Header().Set("Cache-Control", "public, max-age=3600")
					}
					serve(w, r, name, body)
					return
				}
			}
		}
		index, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			http.Error(w, "front end not built (run the web/ build)", http.StatusNotFound)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		serve(w, r, "index.html", index)
	})
}
