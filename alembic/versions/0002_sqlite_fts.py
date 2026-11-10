"""Add optional SQLite FTS candidate indexes."""

from sqlalchemy.exc import OperationalError

from alembic import context, op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

INDEXES = {
    "turns": "question",
    "snapshots": "question || ' ' || {row}.topic_key || ' ' || {row}.search_query",
}


def upgrade():
    if context.get_context().dialect.name != "sqlite":
        return
    for table, expr in INDEXES.items():
        fts = f"{table}_fts"
        try:
            op.execute(f"CREATE VIRTUAL TABLE {fts} USING fts5(doc_id UNINDEXED, body)")
        except OperationalError as exc:
            if "no such module: fts5" not in str(exc.orig).lower():
                raise
            return
        initial = expr.format(row=table)
        inserted = "new." + expr.format(row="new")
        op.execute(f"INSERT INTO {fts}(doc_id, body) SELECT id, {initial} FROM {table}")
        op.execute(
            f"CREATE TRIGGER {table}_fts_insert AFTER INSERT ON {table} "
            f"BEGIN INSERT INTO {fts}(doc_id, body) VALUES (new.id, {inserted}); END"
        )
        op.execute(
            f"CREATE TRIGGER {table}_fts_delete AFTER DELETE ON {table} "
            f"BEGIN DELETE FROM {fts} WHERE doc_id = old.id; END"
        )
        # Application rows are append-only. Also maintain the index for manual maintenance.
        op.execute(
            f"CREATE TRIGGER {table}_fts_update AFTER UPDATE ON {table} "
            f"BEGIN DELETE FROM {fts} WHERE doc_id = old.id; "
            f"INSERT INTO {fts}(doc_id, body) VALUES (new.id, {inserted}); END"
        )


def downgrade():
    if context.get_context().dialect.name != "sqlite":
        return
    for table in reversed(INDEXES):
        for suffix in ("insert", "update", "delete"):
            op.execute(f"DROP TRIGGER IF EXISTS {table}_fts_{suffix}")
        op.execute(f"DROP TABLE IF EXISTS {table}_fts")
