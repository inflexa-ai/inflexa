//go:build linux

package main

import (
	"encoding/binary"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const maxInotifyWatches = 1000

// inotifyWatchMask carries no IN_OPEN. An open attests only that a file
// descriptor was obtained — it fires for opens for *writing* and for opens by
// processes unrelated to the command — so it cannot establish that the command
// consumed the file. The mode-aware Python, R, and LD_PRELOAD hooks classify by
// open mode and are the authoritative read signal; inotify verifies mutations,
// which the mask below is exactly the set of.
const inotifyWatchMask = unix.IN_CREATE | unix.IN_DELETE | unix.IN_MOVED_FROM | unix.IN_MOVED_TO

type linuxInotifyWatcher struct {
	pt     *ProvenanceTracker
	fd     int
	wds    map[int]string // watch descriptor → directory path
	stopCh chan struct{}
	wg     sync.WaitGroup
	// Written by the walk in start(), read after stop().
	exhausted     bool
	watched       int
	unwatchedDirs int
}

func newInotifyWatcher(pt *ProvenanceTracker) inotifyWatcher {
	return &linuxInotifyWatcher{
		pt:     pt,
		fd:     -1,
		wds:    make(map[int]string),
		stopCh: make(chan struct{}),
	}
}

func (w *linuxInotifyWatcher) start(watchDirs []string) {
	if len(watchDirs) == 0 {
		return
	}

	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		log.Printf("[provenance] inotify init failed: %v", err)
		return
	}
	w.fd = fd

	watchCount := 0
	for _, dir := range watchDirs {
		// Strip trailing slash for Walk
		dirClean := filepath.Clean(dir)
		// Walk's own error is discarded because every per-entry error is already
		// handled inside the callback, which never returns one: a configured dir
		// that does not exist (a completed step that produced no tree) is a
		// skip, not a failure.
		_ = filepath.Walk(dirClean, func(path string, info os.FileInfo, err error) error {
			if err != nil || info == nil || !info.IsDir() {
				return nil
			}
			if watchCount >= maxInotifyWatches {
				// Counted, not just logged: this line stays in the container,
				// so without the count on the frame the host cannot tell
				// degraded capture from an exec that touched nothing.
				w.exhausted = true
				w.unwatchedDirs++
				log.Printf("[provenance] inotify watch limit (%d) reached, skipping deeper dirs", maxInotifyWatches)
				return filepath.SkipDir
			}
			wd, err := unix.InotifyAddWatch(fd, path, inotifyWatchMask)
			if err != nil {
				return nil
			}
			w.wds[wd] = path
			watchCount++
			return nil
		})
	}
	w.watched = watchCount

	if watchCount > 0 {
		w.wg.Add(1)
		go w.readLoop()
	}
}

func (w *linuxInotifyWatcher) budget() *watchBudgetSignal {
	if !w.exhausted {
		return nil
	}
	return &watchBudgetSignal{Limit: maxInotifyWatches, Watched: w.watched, UnwatchedDirs: w.unwatchedDirs}
}

func (w *linuxInotifyWatcher) readLoop() {
	defer w.wg.Done()
	buf := make([]byte, 4096)
	for {
		select {
		case <-w.stopCh:
			w.drain(buf)
			return
		default:
			n, err := unix.Read(w.fd, buf)
			if err != nil {
				if err == unix.EAGAIN || err == unix.EWOULDBLOCK {
					time.Sleep(10 * time.Millisecond)
					continue
				}
				return
			}
			w.parseEvents(buf[:n])
		}
	}
}

func (w *linuxInotifyWatcher) drain(buf []byte) {
	deadline := time.Now().Add(provenanceDrainTimeout)
	for time.Now().Before(deadline) {
		n, err := unix.Read(w.fd, buf)
		if err != nil {
			if err == unix.EAGAIN || err == unix.EWOULDBLOCK {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			return
		}
		w.parseEvents(buf[:n])
	}
}

func (w *linuxInotifyWatcher) parseEvents(buf []byte) {
	offset := 0
	const headerSize = 16 // Wd(4) + Mask(4) + Cookie(4) + Len(4)
	for offset+headerSize <= len(buf) {
		wd := int(int32(binary.LittleEndian.Uint32(buf[offset:])))
		mask := binary.LittleEndian.Uint32(buf[offset+4:])
		nameLen := int(binary.LittleEndian.Uint32(buf[offset+12:]))
		nameStart := offset + headerSize
		nameEnd := nameStart + nameLen
		if nameEnd > len(buf) {
			break
		}

		if nameLen > 0 {
			nameBytes := buf[nameStart:nameEnd]
			idx := 0
			for idx < len(nameBytes) && nameBytes[idx] != 0 {
				idx++
			}
			name := string(nameBytes[:idx])

			if dir, ok := w.wds[wd]; ok {
				if op := classifyInotifyMask(mask); op != "" {
					w.pt.recordOp(op, filepath.Join(dir, name), "inotify")
				}
			}
		}

		offset = nameEnd
	}
}

// classifyInotifyMask maps an event mask onto a provenance op, or "" for an
// event that attests nothing and must not be recorded (IN_IGNORED, IN_Q_OVERFLOW,
// and anything else the kernel raises unasked).
//
// It never yields "read". inotify reports that a directory entry changed, not
// which process changed it or in what mode, so no event here can show that this
// command consumed a file as an input — that is the mode-aware hooks' signal.
func classifyInotifyMask(mask uint32) string {
	switch {
	case mask&unix.IN_DELETE != 0, mask&unix.IN_MOVED_FROM != 0:
		return "delete"
	case mask&unix.IN_CREATE != 0, mask&unix.IN_MOVED_TO != 0:
		return "write"
	default:
		return ""
	}
}

func (w *linuxInotifyWatcher) stop() {
	close(w.stopCh)
	w.wg.Wait()

	if w.fd >= 0 {
		for wd := range w.wds {
			unix.InotifyRmWatch(w.fd, uint32(wd))
		}
		unix.Close(w.fd)
		w.fd = -1
	}
}
