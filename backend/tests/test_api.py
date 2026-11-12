from __future__ import annotations

from fastapi.testclient import TestClient
from helpers import demo_request

from sitemind.api import app
from sitemind.models import CreateRunRequest, RunSnapshot, SpecialistSpec

client = TestClient(app)


def test_health_registry_defaults() -> None:
    h = client.get("/api/health").json()
    assert h["status"] == "ok" and h["llm"]["provider"] == "off"
    reg = [SpecialistSpec.model_validate(x) for x in client.get("/api/registry").json()]
    assert {"takeoff", "quotes", "schedule", "budget", "approvals", "po"} <= {s.name for s in reg}
    d = CreateRunRequest.model_validate(client.get("/api/demo/defaults").json())
    assert d.budget_inr == 46_000_000 and str(d.need_by) == "2027-03-15"
    assert d.scenario == "demo" and "480 V switchgear" in d.goal_text


def test_create_without_start_list_get_and_errors() -> None:
    req = demo_request().model_copy(update={"auto_start": False})
    snap = RunSnapshot.model_validate(
        client.post("/api/runs", json=req.model_dump(mode="json")).json()
    )
    assert snap.status.value == "created" and snap.plan is None
    assert snap.sim_start.isoformat().startswith("2027-01-11T09:00")
    runs = client.get("/api/runs").json()
    assert any(r["run_id"] == snap.run_id for r in runs)
    assert client.get(f"/api/runs/{snap.run_id}").status_code == 200
    assert client.get("/api/runs/nope").status_code == 404
    assert client.get(f"/api/runs/{snap.run_id}/po.md").status_code == 404
    bad = client.post(f"/api/runs/{snap.run_id}/approvals/x", json={"decision": "approve"})
    assert bad.status_code == 404
    assert client.post("/api/runs", json={"goal_text": "x"}).status_code == 422


def test_spa_fallback_without_dist(monkeypatch, tmp_path) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("SITEMIND_FRONTEND_DIST", str(tmp_path / "nodist"))
    assert client.get("/").status_code == 200
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "index.html").write_text("<html>spa</html>")
    monkeypatch.setenv("SITEMIND_FRONTEND_DIST", str(tmp_path / "dist"))
    assert "spa" in client.get("/runs/abc").text
    assert client.get("/api/unknown").status_code == 404
