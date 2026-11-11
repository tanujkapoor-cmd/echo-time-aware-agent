import asyncio

from alembic import context
from echo.config import Settings
from echo.db import Base, database, database_url

url = Settings().echo_database_url


def include_name(name, type_, _):
    # FTS tables and their SQLite-owned shadow tables are maintained by migration 0002.
    return not (type_ == "table" and name.startswith(("turns_fts", "snapshots_fts")))


def migrate(connection):
    context.configure(
        connection=connection, target_metadata=Base.metadata, include_name=include_name
    )
    with context.begin_transaction():
        context.run_migrations()


async def online():
    engine, _ = database(url)
    try:
        async with engine.connect() as connection:
            await connection.run_sync(migrate)
    finally:
        await engine.dispose()


if context.is_offline_mode():
    context.configure(url=database_url(url), target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(online())
