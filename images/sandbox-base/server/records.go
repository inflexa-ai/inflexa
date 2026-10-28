package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	envExecRecordDir = "EXEC_RECORD_DIR"
	recordSuffix     = ".json"
	recordTempPrefix = ".tmp-"
	lostReplaced     = "sandbox-replaced"
)

// persistedRecord is the part of an exec record that outlives the process: the
// status, the start time, and the exact completion bytes. The event ring stays
// in memory, because the terminal result, not the event stream, is the outcome.
type persistedRecord struct {
	ExecID     string          `json:"execId"`
	Status     execStatus      `json:"status"`
	StartedAt  time.Time       `json:"startedAt"`
	Completion json.RawMessage `json:"completion,omitempty"`
}

// lostCompletion is the result of an exec whose command the server cannot
// account for: a record that was still running when an earlier process of this
// machine stopped, or a record file that does not read. It carries no exit code,
// thus the host cannot read it as a command that ran to its end.
type lostCompletion struct {
	ExecID     string     `json:"execId"`
	ExitCode   *int       `json:"exitCode"`
	Stdout     string     `json:"stdout"`
	Stderr     string     `json:"stderr"`
	DurationMs *int64     `json:"durationMs"`
	Lost       lostReason `json:"lost"`
}

type lostReason struct {
	Reason string `json:"reason"`
}

// recordStore keeps one file for each exec in a directory that the harness
// mounts from the volume of the analysis files. A replacement machine of the
// same lease mounts the same directory, thus a host that submits an exec id
// again gets the first result and the command does not run a second time.
//
// The commands run under the uid of this server, thus a command can change a
// record file. A changed record changes only the result that a later machine of
// the same lease serves for that exec id. The trust boundary already admits as
// much: a command controls its own output, and it can submit an exec to this
// server through loopback.
type recordStore struct {
	dir string
}

func openRecordStore(dir string) (*recordStore, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, fmt.Errorf("%s is required: the exec records must outlive the machine", envExecRecordDir)
	}
	//nolint:gosec // G703: the harness gives the directory in the env of the machine, not in a request.
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("make the record directory %s: %w", dir, err)
	}
	return &recordStore{dir: dir}, nil
}

func recordFileName(execID string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(execID)) + recordSuffix
}

func execIDFromFileName(name string) (string, bool) {
	encoded, ok := strings.CutSuffix(name, recordSuffix)
	if !ok || encoded == "" {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) == 0 {
		return "", false
	}
	return string(raw), true
}

// write replaces the record of rec.ExecID through a temporary file and a
// rename, thus a reader never sees a partial record.
func (s *recordStore) write(rec persistedRecord) error {
	body, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("marshal the record of %s: %w", rec.ExecID, err)
	}
	tmp, err := os.CreateTemp(s.dir, recordTempPrefix+"*")
	if err != nil {
		return fmt.Errorf("make a temporary record file: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(body); err != nil {
		return discardTemp(tmp, tmpName, fmt.Errorf("write the record of %s: %w", rec.ExecID, err))
	}
	if err := tmp.Sync(); err != nil {
		return discardTemp(tmp, tmpName, fmt.Errorf("sync the record of %s: %w", rec.ExecID, err))
	}
	if err := tmp.Close(); err != nil {
		return discardTemp(nil, tmpName, fmt.Errorf("close the record of %s: %w", rec.ExecID, err))
	}
	// The base64url name of the exec id holds no path separator, thus the file stays in the directory.
	//nolint:gosec // G703: refer to the line above.
	if err := os.Rename(tmpName, filepath.Join(s.dir, recordFileName(rec.ExecID))); err != nil {
		return discardTemp(nil, tmpName, fmt.Errorf("rename the record of %s: %w", rec.ExecID, err))
	}
	return nil
}

func discardTemp(f *os.File, name string, cause error) error {
	if f != nil {
		// SAFETY: the write already failed, and the close only releases the descriptor of a file that the next line removes.
		_ = f.Close()
	}
	//nolint:gosec // G703: the name is a temporary file that this server made in its record directory.
	if err := os.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.Join(cause, fmt.Errorf("remove the temporary record file: %w", err))
	}
	return cause
}

// load reads each record of the directory. A record that was still running
// becomes lost, because the command died with the process that ran it. A file
// that does not read becomes a lost record for the exec id of its name. A file
// whose name names no exec id is skipped. Only an unreadable directory fails
// the load: one bad file never stops the start.
func (s *recordStore) load() ([]persistedRecord, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, fmt.Errorf("read the record directory %s: %w", s.dir, err)
	}
	records := make([]persistedRecord, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() {
			continue
		}
		if strings.HasPrefix(name, recordTempPrefix) {
			// A temporary file of a write that the stop of the process cut. The rename never ran, thus it holds no record.
			//nolint:gosec // G703: the name comes from the listing of the record directory, not from a request.
			if err := os.Remove(filepath.Join(s.dir, name)); err != nil {
				log.Printf("[records] remove the temporary file %q: %v", name, err) //nolint:gosec // G706: %q quotes the name, thus it cannot inject a log line
			}
			continue
		}
		execID, ok := execIDFromFileName(name)
		if !ok {
			log.Printf("[records] skip %q: the name names no exec id", name) //nolint:gosec // G706: %q quotes the name, thus it cannot inject a log line
			continue
		}
		rec, readErr := s.read(name, execID)
		if readErr == nil && isServable(rec) {
			records = append(records, rec)
			continue
		}
		if readErr != nil {
			log.Printf("[records] the record of %q does not read, thus it is lost: %v", execID, readErr) //nolint:gosec // G706: %q quotes the exec id, thus it cannot inject a log line
		} else {
			log.Printf("[records] the command of %q did not end before the stop of the earlier process, thus it is lost", execID) //nolint:gosec // G706: %q quotes the exec id, thus it cannot inject a log line
		}
		lost, lostErr := lostRecord(execID, rec.StartedAt)
		if lostErr != nil {
			log.Printf("[records] make the lost record of %q: %v", execID, lostErr) //nolint:gosec // G706: %q quotes the exec id, thus it cannot inject a log line
			continue
		}
		if err := s.write(lost); err != nil {
			log.Printf("[records] write the lost record of %q: %v", execID, err) //nolint:gosec // G706: %q quotes the exec id, thus it cannot inject a log line
		}
		records = append(records, lost)
	}
	return records, nil
}

func (s *recordStore) read(name, execID string) (persistedRecord, error) {
	//nolint:gosec // G304: the name comes from the listing of the record directory of this server, not from a request.
	body, err := os.ReadFile(filepath.Join(s.dir, name))
	if err != nil {
		return persistedRecord{}, err
	}
	var rec persistedRecord
	if err := json.Unmarshal(body, &rec); err != nil {
		return persistedRecord{}, err
	}
	if rec.ExecID != execID {
		return persistedRecord{}, fmt.Errorf("the record names %q, and its file names %q", rec.ExecID, execID)
	}
	return rec, nil
}

// isServable is true for a terminal record that holds its completion. A running
// record is not: its command died with the process that ran it.
func isServable(rec persistedRecord) bool {
	terminal := rec.Status == execStatusCompleted || rec.Status == execStatusFailed
	return terminal && len(rec.Completion) > 0
}

func lostRecord(execID string, startedAt time.Time) (persistedRecord, error) {
	body, err := json.Marshal(lostCompletion{ExecID: execID, Lost: lostReason{Reason: lostReplaced}})
	if err != nil {
		return persistedRecord{}, err
	}
	return persistedRecord{ExecID: execID, Status: execStatusFailed, StartedAt: startedAt, Completion: body}, nil
}
