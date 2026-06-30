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

type linuxInotifyWatcher struct {
	pt     *ProvenanceTracker
	fd     int
	wds    map[int]string // watch descriptor → directory path
	stopCh chan struct{}
	wg     sync.WaitGroup
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
		filepath.Walk(dirClean, func(path string, info os.FileInfo, err error) error {
			if err != nil || info == nil || !info.IsDir() {
				return nil
			}
			if watchCount >= maxInotifyWatches {
				log.Printf("[provenance] inotify watch limit (%d) reached, skipping deeper dirs", maxInotifyWatches)
				return filepath.SkipDir
			}
			wd, err := unix.InotifyAddWatch(fd, path,
				unix.IN_OPEN|unix.IN_CREATE|unix.IN_DELETE|unix.IN_MOVED_FROM|unix.IN_MOVED_TO)
			if err != nil {
				return nil
			}
			w.wds[wd] = path
			watchCount++
			return nil
		})
	}

	if watchCount > 0 {
		w.wg.Add(1)
		go w.readLoop()
	}
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
				fullPath := filepath.Join(dir, name)
				op := classifyInotifyMask(mask)
				w.pt.recordOp(op, fullPath, "inotify")
			}
		}

		offset = nameEnd
	}
}

func classifyInotifyMask(mask uint32) string {
	switch {
	case mask&unix.IN_DELETE != 0, mask&unix.IN_MOVED_FROM != 0:
		return "delete"
	case mask&unix.IN_CREATE != 0, mask&unix.IN_MOVED_TO != 0:
		return "write"
	default:
		return "read" // IN_OPEN
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
