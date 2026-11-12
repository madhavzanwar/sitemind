"""MCP server tests: in-memory client session (and a real stdio subprocess)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import anyio
import pytest

from sitemind.mcp_server import mcp

EXPECTED_TOOLS = {
    "takeoff_from_pdf",
    "request_vendor_quotes",
    "compute_schedule",
    "check_budget",
    "rank_vendor_options",
    "draft_purchase_order",
    "list_specialists",
}
BACKEND = Path(__file__).resolve().parents[1]


def _payload(result: Any) -> Any:
    sc = getattr(result, "structured_content", None) or getattr(result, "structuredContent", None)
    if sc is not None:
        return sc.get("result", sc) if isinstance(sc, dict) and set(sc) == {"result"} else sc
    return json.loads(result.content[0].text)


async def _with_client(fn: Any) -> Any:
    try:
        from mcp import Client  # SDK v2
    except ImportError:  # pragma: no cover - SDK v1
        from mcp.shared.memory import create_connected_server_and_client_session

        async with create_connected_server_and_client_session(mcp._mcp_server) as session:
            return await fn(session)
    async with Client(mcp) as client:
        return await fn(client)


def test_list_and_call_tools() -> None:
    async def body(c: Any) -> dict[str, Any]:
        tools = await c.list_tools()
        names = {t.name for t in tools.tools}
        sched = _payload(await c.call_tool("compute_schedule", {"lead_time_days": 168}))
        ranked = _payload(await c.call_tool("rank_vendor_options", {"scenario": "demo"}))
        po = _payload(await c.call_tool("draft_purchase_order", {"option_id": "O-V1"}))
        specs = _payload(await c.call_tool("list_specialists", {}))
        return {"names": names, "sched": sched, "ranked": ranked, "po": po, "specs": specs}

    out = anyio.run(_with_client, body)
    assert out["names"] >= EXPECTED_TOOLS
    assert out["sched"]["float_days"] == -13 and out["sched"]["meets_deadline"] is False
    assert out["ranked"]["memo"]["recommendation"] == "O-V3X"
    assert out["po"]["vendor_id"] == "V1" and out["po"]["gst_inr"] > 0
    assert len(out["specs"]) == 7


def test_check_budget_tool_round_trips_quote() -> None:
    async def body(c: Any) -> Any:
        q = _payload(
            await c.call_tool("request_vendor_quotes", {"vendor_ids": ["V2"], "refresh": True})
        )
        assert q["attempts"][-1]["outcome"] == "revised"
        return _payload(await c.call_tool("check_budget", {"quote": q["quotes"][0]}))

    b = anyio.run(_with_client, body)
    assert b["verdict"] == "breach" and b["utilisation"] > 1.0


@pytest.mark.skipif(os.environ.get("SITEMIND_SKIP_STDIO") == "1", reason="stdio disabled")
def test_stdio_subprocess() -> None:
    try:
        from mcp import Client, StdioServerParameters
    except ImportError:  # pragma: no cover
        pytest.skip("stdio client test written for SDK v2")
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "sitemind.mcp_server"],
        cwd=str(BACKEND),
        env={**os.environ, "PYTHONPATH": str(BACKEND)},
    )

    async def run() -> set[str]:
        async with Client(params) as c:
            tools = await c.list_tools()
            res = _payload(await c.call_tool("takeoff_from_pdf", {}))
            assert len(res["lines"]) == 8
            return {t.name for t in tools.tools}

    assert anyio.run(run) >= EXPECTED_TOOLS
