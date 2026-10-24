# db/ — Supabase Postgres warehouse

```bash
cp .env.example .env            # then put the real password in SUPABASE_DB_URL (never commit it)
python -m db.migrate --smoke    # select 1
python -m db.migrate            # apply db/migrations/*.sql (re-runnable, checksum-locked)
python -m db.load.backfill all  # reference -> prices -> calendar -> forward -> literal -> flags -> threshold -> reconcile
```

- Direct host is IPv6-only by default; on an IPv4-only network use the **Session pooler** string (Supabase → Connect).
- `--scope universe` (default) loads daily/weekly bars for index-universe tickers only; `--scope all` loads every ticker (≈2× the size — check your plan's DB limit first).
- Tests use an embedded throwaway Postgres (`pgserver`), never Supabase: `pytest tests/test_db_migrations.py tests/test_storage_parity.py`.
- `DATA_BACKEND=file|postgres` selects `src/storage` implementation (default `file`).
