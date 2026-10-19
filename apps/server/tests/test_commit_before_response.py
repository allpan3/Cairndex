"""A successful HTTP reply must follow its registry transaction's commit."""

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from cairndex.api.deps import RegistryDbSession
from cairndex.registry import engine as registry_engine


@pytest.mark.parametrize("commit_fails", [False, True])
def test_registry_commit_precedes_response_start(tmp_path: Path, monkeypatch, commit_fails):
    engine = registry_engine.create_registry_engine(f"sqlite:///{tmp_path / 'registry.db'}")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE commit_probe (id INTEGER PRIMARY KEY)"))

    class CommitSession(Session):
        def commit(self):
            if commit_fails:
                raise RuntimeError("Synthetic commit failure")
            super().commit()

    factory = sessionmaker(bind=engine, class_=CommitSession, expire_on_commit=False)
    monkeypatch.setattr(registry_engine, "get_registry_sessionmaker", lambda: factory)
    app = FastAPI()

    @app.post("/write", status_code=201)
    def write(db: RegistryDbSession):
        db.execute(text("INSERT INTO commit_probe VALUES (1)"))
        return {"saved": True}

    observed = []

    async def probe(scope, receive, send):
        async def record(message):
            if message["type"] == "http.response.start":
                # This is a separate connection, as an immediate follow-up request uses.
                with engine.connect() as reader:
                    visible = reader.scalar(text("SELECT count(*) FROM commit_probe"))
                observed.append((message["status"], visible))
            await send(message)

        await app(scope, receive, record)

    try:
        with TestClient(probe, raise_server_exceptions=False) as client:
            response = client.post("/write")
        expected = (500, 0) if commit_fails else (201, 1)
        assert observed == [expected]
        assert response.status_code == expected[0]
    finally:
        engine.dispose()
