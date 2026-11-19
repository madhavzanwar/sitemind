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


# --------------------------------------------------------------------------- v2 endpoints


def test_packages_event_types_and_package_defaults() -> None:
    pk = client.get("/api/packages").json()
    ids = {p["package_id"] for p in pk}
    assert {"swgr-480v", "dg-2mw"} <= ids
    et = client.get("/api/event-types").json()
    assert {e["type"] for e in et} == {
        "vendor_late_reply",
        "price_change",
        "date_slip",
        "document_missing",
        "tool_failure",
        "approver_unavailable",
        "restart",
    }
    pc = next(e for e in et if e["type"] == "price_change")
    assert pc["needs_vendor"] and pc["params"][0]["name"] == "pct"
    d = CreateRunRequest.model_validate(
        client.get("/api/demo/defaults", params={"package_id": "dg-2mw"}).json()
    )
    assert d.package_id == "dg-2mw" and d.package == "2 MW DG sets"
    assert d.budget_inr == 380_000_000 and str(d.need_by) == "2027-04-30"
    assert client.get("/api/demo/defaults", params={"package_id": "nope"}).status_code == 404


def test_goal_parse_endpoint() -> None:
    r = client.post(
        "/api/goal/parse",
        json={
            "text": "Get the 2 MW DG sets for Project Alpha ordered by 2027-04-30 within "
            "budget ₹38 Cr"
        },
    )
    assert r.status_code == 200
    g = r.json()
    assert g["package_id"] == "dg-2mw" and g["need_by"] == "2027-04-30"
    assert g["budget_inr"] == 380_000_000 and g["supported"] is True
    bad = client.post("/api/goal/parse", json={"text": "Buy 40 chillers for Project Beta"}).json()
    assert bad["supported"] is False and bad["questions"]


def test_spec_upload_preview_and_run_uses_upload() -> None:
    from sitemind.runner import run_worker
    from sitemind.specialists.packages import package_spec_pdf

    pdf = package_spec_pdf("dg-2mw").read_bytes()
    r = client.post("/api/specs", files={"file": ("my_dg_spec.pdf", pdf, "application/pdf")})
    assert r.status_code == 200, r.text
    up = r.json()
    assert up["filename"] == "my_dg_spec.pdf" and up["pages"] >= 2
    assert up["package_id"] == "dg-2mw" and up["takeoff"]["lines"]
    assert all("p" in ln["source"] for ln in up["takeoff"]["lines"])
    bad = client.post("/api/specs", files={"file": ("x.pdf", b"hello", "application/pdf")})
    assert bad.status_code == 415

    req = client.get("/api/demo/defaults", params={"package_id": "dg-2mw"}).json()
    req.update({"spec_upload_id": up["upload_id"], "auto_start": False})
    snap = client.post("/api/runs", json=req).json()
    assert snap["package_id"] == "dg-2mw"
    run_worker(snap["run_id"])  # stops at the first approval
    s = RunSnapshot.model_validate(client.get(f"/api/runs/{snap['run_id']}").json())
    assert s.takeoff is not None and s.takeoff.document.endswith(".pdf")
    assert s.takeoff.document == "my_dg_spec.pdf"  # the uploaded file, not the bundled sample
    bad_up = dict(req, spec_upload_id="up-missing")
    assert client.post("/api/runs", json=bad_up).status_code == 404


def test_post_event_records_pending_and_validates() -> None:
    req = demo_request().model_copy(update={"auto_start": False})
    rid = client.post("/api/runs", json=req.model_dump(mode="json")).json()["run_id"]
    r = client.post(
        f"/api/runs/{rid}/events",
        json={"type": "price_change", "vendor_id": "V2", "params": {"pct": 5}},
    )
    assert r.status_code == 200
    evs = r.json()["events"]
    assert evs[0]["id"] == "ev-1" and evs[0]["status"] == "pending"
    assert evs[0]["params"] == {"pct": 5}
    assert client.post(f"/api/runs/{rid}/events", json={"type": "price_change"}).status_code == 422
    assert client.post(f"/api/runs/{rid}/events", json={"type": "bogus"}).status_code == 422
    assert client.post("/api/runs/nope/events", json={"type": "restart"}).status_code == 404
