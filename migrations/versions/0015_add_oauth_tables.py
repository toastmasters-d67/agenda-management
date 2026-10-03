"""add_oauth_tables

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-02 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '0015'
down_revision: Union[str, None] = '0014'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # One in-flight authorization code. Short-lived by design: the code is
    # exchanged for a token within seconds of the user pressing Allow.
    #
    # Only the HASH is stored. A code is a bearer credential for the few
    # seconds it lives, and a database dump should not hand anyone a usable
    # one — the same reason the password column holds a bcrypt hash.
    #
    # This is a table rather than a process-local dict because the authorize
    # and token calls are two different serverless invocations; anything held
    # in memory would simply not be there on the second one.
    op.execute("""
        CREATE TABLE IF NOT EXISTS oauth_codes (
            code_hash      TEXT PRIMARY KEY,
            client_id      TEXT        NOT NULL,
            username       VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            redirect_uri   TEXT        NOT NULL,
            code_challenge TEXT        NOT NULL,
            resource       TEXT        NOT NULL,
            scope          TEXT        NOT NULL,
            expires_at     TIMESTAMPTZ NOT NULL,
            created_at     TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    # Sweeping expired rows is cheap and keeps the table from growing without
    # bound; nothing reads a code after it expires.
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_oauth_codes_expires
        ON oauth_codes (expires_at)
    """)

    # Refresh tokens are stored (again, hashed) because unlike access tokens
    # they must be revocable: an officer who leaves, or a client that is no
    # longer trusted, has to be cut off without waiting for an expiry. Access
    # tokens stay self-contained JWTs and are kept short-lived instead.
    op.execute("""
        CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
            token_hash   TEXT PRIMARY KEY,
            client_id    TEXT        NOT NULL,
            username     VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            scope        TEXT        NOT NULL,
            resource     TEXT        NOT NULL,
            expires_at   TIMESTAMPTZ,
            revoked_at   TIMESTAMPTZ,
            last_used_at TIMESTAMPTZ,
            created_at   TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_oauth_refresh_user
        ON oauth_refresh_tokens (username, revoked_at)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_oauth_refresh_user")
    op.execute("DROP TABLE IF EXISTS oauth_refresh_tokens")
    op.execute("DROP INDEX IF EXISTS ix_oauth_codes_expires")
    op.execute("DROP TABLE IF EXISTS oauth_codes")
