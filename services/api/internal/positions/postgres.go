package positions

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrConflict = errors.New("position changed")
var ErrOperationReused = errors.New("operation reused with different payload")

type Locator struct {
	BookID    string  `json:"bookId"`
	Version   string  `json:"version"`
	Chapter   int     `json:"chapter"`
	Paragraph string  `json:"paragraph"`
	Offset    float64 `json:"offset"`
}
type Position struct {
	Locator
	Revision int64 `json:"revision"`
}
type Choice struct {
	OperationID      string  `json:"operationId"`
	ExpectedRevision int64   `json:"expectedRevision"`
	Position         Locator `json:"position"`
}
type Store interface {
	List(context.Context, string) ([]Position, error)
	Choose(context.Context, string, Choice) (Position, error)
}
type Postgres struct{ Pool *pgxpool.Pool }

func (s Postgres) List(ctx context.Context, owner string) ([]Position, error) {
	rows, err := s.Pool.Query(ctx, `SELECT book_id,book_version,locator,server_revision FROM reading_positions WHERE user_id=$1 ORDER BY book_id`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Position, 0)
	for rows.Next() {
		var p Position
		var data []byte
		var book, version string
		if err := rows.Scan(&book, &version, &data, &p.Revision); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(data, &p.Locator); err != nil {
			return nil, err
		}
		p.BookID, p.Version = book, version
		result = append(result, p)
	}
	return result, rows.Err()
}

type receipt struct {
	Kind        string   `json:"kind"`
	Fingerprint []byte   `json:"fingerprint"`
	Position    Position `json:"position"`
}

func (s Postgres) Choose(ctx context.Context, owner string, choice Choice) (Position, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Position{}, err
	}
	defer tx.Rollback(ctx)
	var id string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, owner).Scan(&id); err != nil {
		return Position{}, err
	}
	encoded, err := json.Marshal(choice)
	if err != nil {
		return Position{}, err
	}
	fingerprint := sha256.Sum256(encoded)
	var previous []byte
	err = tx.QueryRow(ctx, `SELECT result FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, owner, choice.OperationID).Scan(&previous)
	if err == nil {
		var stored receipt
		if err = json.Unmarshal(previous, &stored); err != nil {
			return Position{}, err
		}
		if stored.Kind != "position.choose.v1" || string(stored.Fingerprint) != string(fingerprint[:]) {
			return Position{}, ErrOperationReused
		}
		return stored.Position, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Position{}, err
	}
	var revision int64
	err = tx.QueryRow(ctx, `SELECT server_revision FROM reading_positions WHERE user_id=$1 AND book_id=$2`, owner, choice.Position.BookID).Scan(&revision)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Position{}, err
	}
	if revision != choice.ExpectedRevision {
		return Position{}, ErrConflict
	}
	if revision > 0 {
		if _, err = tx.Exec(ctx, `INSERT INTO reading_position_history(user_id,book_id,book_version,locator,server_revision)
   SELECT user_id,book_id,book_version,locator,server_revision FROM reading_positions WHERE user_id=$1 AND book_id=$2`, owner, choice.Position.BookID); err != nil {
			return Position{}, err
		}
	}
	data, err := json.Marshal(choice.Position)
	if err != nil {
		return Position{}, err
	}
	result := Position{Locator: choice.Position, Revision: revision + 1}
	if _, err = tx.Exec(ctx, `INSERT INTO reading_positions(user_id,book_id,book_version,locator,server_revision) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(user_id,book_id) DO UPDATE SET book_version=excluded.book_version,locator=excluded.locator,server_revision=excluded.server_revision,updated_at=now()`, owner, result.BookID, result.Version, data, result.Revision); err != nil {
		return Position{}, err
	}
	stored, err := json.Marshal(receipt{Kind: "position.choose.v1", Fingerprint: fingerprint[:], Position: result})
	if err != nil {
		return Position{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO processed_operations(user_id,operation_id,result) VALUES($1,$2,$3)`, owner, choice.OperationID, stored); err != nil {
		return Position{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Position{}, err
	}
	return result, nil
}
