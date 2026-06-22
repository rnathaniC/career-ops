// kanban-server: minimal static file server for dashboard/job-pulse-kanban.html
//
// Usage: go run ./dashboard/cmd/kanban-server  (or: npm run kanban)
// Opens http://localhost:7777/job-pulse-kanban.html in the default browser.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func main() {
	port := flag.Int("port", 7777, "HTTP port")
	noBrowser := flag.Bool("no-browser", false, "Don't open browser automatically")
	flag.Parse()

	// Locate the dashboard/ directory relative to this binary's source.
	// When run via `go run ./dashboard/cmd/kanban-server` from career-ops root,
	// the working directory is career-ops/.
	dashDir := "dashboard"
	if _, err := os.Stat(dashDir); os.IsNotExist(err) {
		// Fallback: try two levels up (when run from cmd/kanban-server/)
		dashDir = filepath.Join("..", "..")
	}

	addr := fmt.Sprintf(":%d", *port)
	url  := fmt.Sprintf("http://localhost:%d/job-pulse-kanban.html", *port)

	log.Printf("Job Pulse Kanban → %s", url)
	log.Printf("Serving dashboard/ at http://localhost:%d", *port)

	http.Handle("/", http.FileServer(http.Dir(dashDir)))

	if !*noBrowser {
		go openBrowser(url)
	}

	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	cmd.Start() //nolint:errcheck — best-effort
}
