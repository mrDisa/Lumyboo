// Package readingcoverage stores geometric client observations, not proof of
// reading, book completion or eligibility for rewards.
package readingcoverage

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"lumyboo/services/api/internal/readingsessions"
)

const Scale = 1_000_000
const MaxIncomingRanges = 64
const MaxStoredRanges = 256

var (
	ErrInvalid         = errors.New("invalid text coverage")
	ErrOperationReused = errors.New("operation reused with different payload")
	ErrFragmentLimit   = errors.New("too many disjoint coverage fragments")
)

// Integer millionths avoid float drift. Short/long arrays must not be padded
// or truncated by encoding/json's default fixed-array decoding.
type Range [2]int

func (r *Range) UnmarshalJSON(data []byte) error {
	var values []*int
	if err := json.Unmarshal(data, &values); err != nil {
		return err
	}
	if len(values) != 2 || values[0] == nil || values[1] == nil {
		return ErrInvalid
	}
	*r = Range{*values[0], *values[1]}
	return nil
}

type Coverage struct {
	BookID    string  `json:"bookId"`
	Version   string  `json:"version"`
	Paragraph string  `json:"paragraph"`
	Ranges    []Range `json:"ranges"`
}
type Change struct {
	OperationID string   `json:"operationId"`
	Coverage    Coverage `json:"coverage"`
}
type Page struct {
	Items      []Coverage `json:"items"`
	NextCursor string     `json:"nextCursor"`
}
type Store interface {
	Apply(context.Context, string, Change) (Coverage, error)
	List(context.Context, string, string, string, string, int) (Page, error)
}
type Postgres struct{ Pool *pgxpool.Pool }

func ValidKey(s string) bool {
	return s != "" && !strings.ContainsRune(s, 0) && utf8.ValidString(s) && utf8.RuneCountInString(s) <= 200
}
func Valid(change Change) bool {
	p := change.Coverage
	if !readingsessions.ValidID(change.OperationID) || !ValidKey(p.BookID) || !ValidKey(p.Version) || !ValidKey(p.Paragraph) || len(p.Ranges) == 0 || len(p.Ranges) > MaxIncomingRanges {
		return false
	}
	_, err := Merge(p.Ranges)
	return err == nil
}
func Merge(ranges []Range) ([]Range, error) {
	sorted := append([]Range(nil), ranges...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i][0] < sorted[j][0] })
	result := make([]Range, 0, len(sorted))
	for _, r := range sorted {
		if r[0] < 0 || r[1] > Scale || r[0] >= r[1] {
			return nil, ErrInvalid
		}
		if len(result) > 0 && r[0] <= result[len(result)-1][1] {
			result[len(result)-1][1] = max(result[len(result)-1][1], r[1])
		} else {
			result = append(result, r)
		}
	}
	if len(result) > MaxStoredRanges {
		return nil, ErrFragmentLimit
	}
	return result, nil
}

type receipt struct {
	Kind        string   `json:"kind"`
	Fingerprint []byte   `json:"fingerprint"`
	Coverage    Coverage `json:"coverage"`
}

func (s Postgres) Apply(ctx context.Context, owner string, change Change) (Coverage, error) {
	if !Valid(change) {
		return Coverage{}, ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Coverage{}, err
	}
	defer tx.Rollback(ctx)
	// Serialize with all account writes using the existing shared receipt space.
	var id string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, owner).Scan(&id); err != nil {
		return Coverage{}, err
	}
	encoded, err := json.Marshal(change)
	if err != nil {
		return Coverage{}, err
	}
	fingerprint := sha256.Sum256(encoded)
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT result FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, owner, change.OperationID).Scan(&raw)
	if err == nil {
		var stored receipt
		if err = json.Unmarshal(raw, &stored); err != nil {
			return Coverage{}, err
		}
		if stored.Kind != "reading-coverage.apply.v1" || string(stored.Fingerprint) != string(fingerprint[:]) {
			return Coverage{}, ErrOperationReused
		}
		return stored.Coverage, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Coverage{}, err
	}
	p := change.Coverage
	var previous []Range
	err = tx.QueryRow(ctx, `SELECT ranges FROM reading_coverage WHERE user_id=$1 AND book_id=$2 AND book_version=$3 AND paragraph=$4`, owner, p.BookID, p.Version, p.Paragraph).Scan(&raw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Coverage{}, err
	}
	exists := err == nil
	if exists {
		if err = json.Unmarshal(raw, &previous); err != nil {
			return Coverage{}, err
		}
	}
	p.Ranges, err = Merge(append(previous, p.Ranges...))
	if err != nil {
		return Coverage{}, err
	}
	merged, err := json.Marshal(p.Ranges)
	if err != nil {
		return Coverage{}, err
	}
	before, err := json.Marshal(previous)
	if err != nil {
		return Coverage{}, err
	}
	if !exists || string(before) != string(merged) {
		_, err = tx.Exec(ctx, `INSERT INTO reading_coverage(user_id,book_id,book_version,paragraph,ranges) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(user_id,book_id,book_version,paragraph) DO UPDATE SET ranges=excluded.ranges,updated_at=now()`, owner, p.BookID, p.Version, p.Paragraph, merged)
		if err != nil {
			return Coverage{}, err
		}
	}
	stored, err := json.Marshal(receipt{Kind: "reading-coverage.apply.v1", Fingerprint: fingerprint[:], Coverage: p})
	if err != nil {
		return Coverage{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO processed_operations(user_id,operation_id,result) VALUES($1,$2,$3)`, owner, change.OperationID, stored); err != nil {
		return Coverage{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Coverage{}, err
	}
	return p, nil
}

// Live pages ordered by immutable paragraph ID, not reading order. Updates to
// ranges do not move rows; new earlier IDs require refreshing from the start.
func (s Postgres) List(ctx context.Context, owner, book, version, cursor string, limit int) (Page, error) {
	if !ValidKey(book) || !ValidKey(version) || cursor != "" && !ValidKey(cursor) || limit < 1 || limit > 50 {
		return Page{}, ErrInvalid
	}
	rows, err := s.Pool.Query(ctx, `SELECT paragraph,ranges FROM reading_coverage WHERE user_id=$1 AND book_id=$2 AND book_version=$3 AND paragraph COLLATE "C" > $4 COLLATE "C" ORDER BY paragraph COLLATE "C" LIMIT $5`, owner, book, version, cursor, limit+1)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	result := Page{Items: make([]Coverage, 0, limit)}
	for rows.Next() {
		p := Coverage{BookID: book, Version: version}
		var raw []byte
		if err = rows.Scan(&p.Paragraph, &raw); err != nil {
			return Page{}, err
		}
		if err = json.Unmarshal(raw, &p.Ranges); err != nil {
			return Page{}, err
		}
		result.Items = append(result.Items, p)
	}
	if err = rows.Err(); err != nil {
		return Page{}, err
	}
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		result.NextCursor = result.Items[limit-1].Paragraph
	}
	return result, nil
}
