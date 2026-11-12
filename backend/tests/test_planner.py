from __future__ import annotations

from datetime import date, datetime

import pytest

from sitemind.config import SIM_START
from sitemind.models import Goal, PlanTask, TaskStatus
from sitemind.planner import (
    PlanError,
    is_complete,
    make_plan,
    ready_tasks,
    replan,
    task_action,
    topo_order,
    validate_plan,
)
from sitemind.specialists.registry import REGISTRY

GOAL = Goal(
    text="Get the 480 V switchgear package ordered by 2027-03-15 within ₹4.6 Cr",
    need_by=date(2027, 3, 15),
    required_on_site=date(2027, 7, 30),
    budget_inr=46_000_000,
)


def plan_v1():
    return make_plan(GOAL, REGISTRY, SIM_START, None)


def test_plan_is_valid_dag_with_expected_structure() -> None:
    p = plan_v1()
    validate_plan(p)
    actions = [task_action(t)[0] for t in p.tasks]
    assert actions[0] == "takeoff" and actions[-1] == "send-po"
    for a in ("rfq", "levelling", "schedule", "budget", "rank", "approve-vendor", "draft-po",
              "approve-po"):
        assert a in actions
    assert sum(1 for a in actions if a == "schedule") == 3
    order = topo_order(p)
    pos = {tid: i for i, tid in enumerate(order)}
    for t in p.tasks:
        for d in t.depends_on:
            assert pos[d] < pos[t.id]
    assert len(p.risks) >= 4 and p.rationale


def test_deadlines_backward_scheduled_before_need_by() -> None:
    p = plan_v1()
    by = {task_action(t)[0]: t for t in p.tasks}
    assert all(t.deadline is not None and t.deadline <= GOAL.need_by for t in p.tasks)
    assert by["takeoff"].deadline == date(2027, 1, 12)
    assert by["approve-vendor"].deadline == date(2027, 3, 8)
    # deadlines are monotone along dependencies
    ids = {t.id: t for t in p.tasks}
    for t in p.tasks:
        for d in t.depends_on:
            assert ids[d].deadline <= t.deadline  # type: ignore[operator]


def test_ready_tasks_follow_dependencies() -> None:
    p = plan_v1()
    assert [t.id for t in ready_tasks(p)] == ["T1-takeoff"]
    p.tasks[0].status = TaskStatus.done
    assert [task_action(t)[0] for t in ready_tasks(p)] == ["rfq"]
    assert not is_complete(p)


def _finish_until(p, action: str) -> None:
    for tid in topo_order(p):
        t = next(x for x in p.tasks if x.id == tid)
        if task_action(t)[0] == action:
            return
        t.status = TaskStatus.done


def test_replan_keeps_done_and_supersedes_rank() -> None:
    p = plan_v1()
    _finish_until(p, "rank")
    done_before = {t.id for t in p.tasks if t.status == TaskStatus.done}
    facts = {"expedite_offers": {"V3": {"days": 42, "fee_inr": 2_600_000}}}
    p2 = replan(p, ["budget_breach:V2", "deadline_break:V3"], facts, SIM_START, None, goal=GOAL)
    assert p2.version == 2
    validate_plan(p2)
    assert done_before <= {t.id for t in p2.tasks if t.status == TaskStatus.done}
    old_rank = next(t for t in p2.tasks if t.id == "T10-rank")
    assert old_rank.status == TaskStatus.skipped and "superseded" in (old_rank.note or "")
    added = {task_action(t) for t in p2.tasks if t.plan_version == 2}
    assert ("negotiate", "V2") in added and ("expedite", "V3") in added
    assert ("escalate", None) in added and ("rank", None) in added
    esc = next(t for t in p2.tasks if task_action(t)[0] == "escalate")
    appr = next(t for t in p2.tasks if task_action(t)[0] == "approve-vendor")
    assert appr.depends_on == [esc.id]
    exp = next(t for t in p2.tasks if task_action(t)[0] == "expedite")
    assert exp.budget_inr == 2_600_000
    assert {r.id for r in p2.risks} >= {"R6-budget-breach", "R7-expedite"}
    assert [task_action(t)[0] for t in ready_tasks(p2)] == ["negotiate", "expedite"]


def test_replan_after_rejection_clones_downstream() -> None:
    p = plan_v1()
    _finish_until(p, "approve-vendor")
    appr = next(t for t in p.tasks if task_action(t)[0] == "approve-vendor")
    appr.status = TaskStatus.failed
    p2 = replan(p, f"approval_rejected:{appr.id}", {}, SIM_START, None, goal=GOAL)
    validate_plan(p2)
    live = [task_action(t)[0] for t in p2.tasks if t.status == TaskStatus.pending]
    assert live == ["rank", "approve-vendor", "draft-po", "approve-po", "send-po"]
    assert all(t.status == TaskStatus.skipped for t in p2.tasks
               if t.plan_version == 1 and task_action(t)[0] in ("draft-po", "send-po"))


def test_validate_rejects_cycles_and_unknown_deps() -> None:
    p = plan_v1()
    p.tasks[0].depends_on = [p.tasks[-1].id]
    with pytest.raises(PlanError):
        validate_plan(p)
    p = plan_v1()
    p.tasks.append(PlanTask(id="T99-rank", title="x", specialist="approvals",
                            depends_on=["T404-nope"]))
    with pytest.raises(PlanError):
        validate_plan(p)


def test_task_action_parsing() -> None:
    assert task_action("T4-schedule-V1") == ("schedule", "V1")
    assert task_action("T9-approve-vendor") == ("approve-vendor", None)
    assert task_action("T13-draft-po") == ("draft-po", None)


def test_llm_narrative_used_when_available() -> None:
    from sitemind.llm import LLM

    p = make_plan(GOAL, REGISTRY, datetime(2027, 1, 11, 9, tzinfo=SIM_START.tzinfo), LLM())
    assert p.rationale  # provider "off" -> deterministic template
