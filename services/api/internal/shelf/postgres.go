// Package shelf stores account shelves. Guest import is additive and never
// changes reading progress, bookmarks, settings or another account's shelf.
package shelf

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store interface {
	List(context.Context, string) ([]string, error)
	Import(context.Context, string, []string) ([]string, error)
}
type Postgres struct{ Pool *pgxpool.Pool }

func list(ctx context.Context, query interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, userID string) ([]string, error) {
	rows, err := query.Query(ctx, `SELECT book_id FROM shelf WHERE user_id=$1 ORDER BY book_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
func (s Postgres) List(ctx context.Context, userID string) ([]string, error) {
	return list(ctx, s.Pool, userID)
}
func (s Postgres) Import(ctx context.Context, userID string, bookIDs []string) ([]string, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Serialize imports for this user; the unique key makes retries safe even
	// when the original commit succeeded but its response was lost.
	var owner string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, userID).Scan(&owner); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO shelf(user_id,book_id) SELECT $1, unnest($2::text[]) ON CONFLICT(user_id,book_id) DO NOTHING`, userID, bookIDs); err != nil {
		return nil, err
	}
	ids, err := list(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return ids, nil
}
