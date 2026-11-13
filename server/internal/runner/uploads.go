package runner

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Images pasted or attached to an issue's description, a comment or an adjustment
// request are kept in the data folder and referenced in the markdown as
// /api/uploads/<name>. The name is random (it is the credential to read it) and its
// extension comes from the sniffed content.
var UploadName = regexp.MustCompile(`^[0-9a-f]{32}\.(?:png|jpg|gif|webp)$`)

var reUploadRef = regexp.MustCompile(`/api/uploads/([0-9a-f]{32}\.(?:png|jpg|gif|webp))`)

// UploadExt: the extension for an accepted image type ("" = not accepted).
func UploadExt(contentType string) string {
	switch contentType {
	case "image/png":
		return "png"
	case "image/jpeg":
		return "jpg"
	case "image/gif":
		return "gif"
	case "image/webp":
		return "webp"
	}
	return ""
}

func (r *Runner) UploadDir() string { return r.cfg.Path("uploads") }

// localizeUploads copies the images the prompt references into dir (inside the issue's
// folder, which the agent can read) and points the references to those files, so the
// agent opens them with its file tool. Images that no longer exist stay as they were.
func (r *Runner) localizeUploads(prompt, dir string) string {
	var copied []string
	seen := map[string]bool{}
	out := reUploadRef.ReplaceAllStringFunc(prompt, func(ref string) string {
		name := reUploadRef.FindStringSubmatch(ref)[1]
		dst := filepath.Join(dir, name)
		if !seen[name] {
			seen[name] = true
			data, err := os.ReadFile(filepath.Join(r.UploadDir(), name))
			if err != nil {
				return ref
			}
			os.MkdirAll(dir, 0o755)
			if err := os.WriteFile(dst, data, 0o644); err != nil {
				return ref
			}
			copied = append(copied, dst)
		} else if !fileExists(dst) {
			return ref
		}
		return dst
	})
	if len(copied) == 0 {
		return out
	}
	block := "\n\n## Attached images\n" +
		"The request has images. Open each one with your file-reading tool before starting; they are part of what is being asked:\n" +
		fmt.Sprintf("- `%s`", strings.Join(copied, "`\n- `"))
	// Before the closing instructions, which stay last.
	if i := strings.LastIndex(out, "\n\n## When you finish"); i >= 0 {
		return out[:i] + block + out[i:]
	}
	return out + block
}
