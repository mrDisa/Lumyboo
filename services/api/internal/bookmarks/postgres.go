package bookmarks

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Entry keeps book edition and paragraph identity; the screen/page is not a locator.
type Entry struct {
	BookID    string  `json:"bookId"`
	Version   string  `json:"version"`
	Chapter   int     `json:"chapter"`
	Paragraph string  `json:"paragraph"`
	Offset    float64 `json:"offset"`
	Label     string  `json:"label"`
}
type Store interface {
	State(context.Context, string) ([]State, error)
	Apply(context.Context, string, Change) (State, error)
	List(context.Context, string) ([]Entry, error)
	Import(context.Context, string, []Entry) ([]Entry, error)
}
type Postgres struct{ Pool *pgxpool.Pool }

// Include ownership in the UUID: identical local bookmark keys from two guests
// can never collide with a bookmark belonging to another account.
func entryID(owner string, entry Entry) string {
	data, _ := json.Marshal([]string{owner, entry.BookID, entry.Version, entry.Paragraph})
	hash := sha256.Sum256(data)
	hash[6] = (hash[6] & 15) | 80
	hash[8] = (hash[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", hash[:4], hash[4:6], hash[6:8], hash[8:10], hash[10:16])
}
func list(ctx context.Context, query interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, owner string) ([]Entry, error) {
	rows, err := query.Query(ctx, `SELECT book_id,book_version,locator FROM bookmarks WHERE user_id=$1 AND deleted_at IS NULL ORDER BY book_id,book_version,locator->>'paragraph'`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := make([]Entry, 0)
	for rows.Next() {
		var entry Entry
		var raw []byte
		if err := rows.Scan(&entry.BookID, &entry.Version, &raw); err != nil {
			return nil, err
		}
		var locator struct {
			Chapter   int     `json:"chapter"`
			Paragraph string  `json:"paragraph"`
			Offset    float64 `json:"offset"`
			Label     string  `json:"label"`
		}
		if err := json.Unmarshal(raw, &locator); err != nil {
			return nil, err
		}
		entry.Chapter, entry.Paragraph, entry.Offset, entry.Label = locator.Chapter, locator.Paragraph, locator.Offset, locator.Label
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}
func (s Postgres) List(ctx context.Context, owner string) ([]Entry, error) {
	return list(ctx, s.Pool, owner)
}
func (s Postgres) Import(ctx context.Context, owner string, entries []Entry) ([]Entry, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var user string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, owner).Scan(&user); err != nil {
		return nil, err
	}
	for _, entry := range entries {
		locator, err := json.Marshal(entry)
		if err != nil {
			return nil, err
		}
		// Existing labels, offsets, and deletion tombstones win over a guest copy.
		// Also match natural identity, including records created by older clients.
		_, err = tx.Exec(ctx, `INSERT INTO bookmarks(id,user_id,book_id,book_version,locator)
   SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS(
    SELECT 1 FROM bookmarks WHERE user_id=$2 AND book_id=$3 AND book_version=$4 AND locator->>'paragraph'=$6
   ) ON CONFLICT(id) DO NOTHING`, entryID(owner, entry), owner, entry.BookID, entry.Version, locator, entry.Paragraph)
		if err != nil {
			return nil, err
		}
	}
	result, err := list(ctx, tx, owner)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
