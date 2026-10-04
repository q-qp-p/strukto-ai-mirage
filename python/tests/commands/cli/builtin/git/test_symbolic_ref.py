# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from pathlib import Path

import pytest


async def run(ws, line: str) -> tuple[int, str, str]:
    result = await ws.shell(f"git -C /repo {line}")
    return (
        result.exit_code,
        (result.stdout or b"").decode(),
        (result.stderr or b"").decode(),
    )


def log_lines(repo_path: Path, *parts: str) -> list[bytes]:
    path = repo_path.joinpath(".git", "logs", *parts)
    return path.read_bytes().splitlines() if path.exists() else []


@pytest.mark.asyncio
async def test_reads_where_head_points(git_ws):
    assert await run(git_ws, "symbolic-ref HEAD") == (
        0,
        "refs/heads/main\n",
        "",
    )
    assert await run(git_ws, "symbolic-ref --short HEAD") == (0, "main\n", "")


@pytest.mark.asyncio
async def test_a_ref_holding_an_id_is_refused_or_quietly_exits_one(git_ws):
    assert await run(git_ws, "symbolic-ref refs/heads/main") == (
        128,
        "",
        "fatal: ref refs/heads/main is not a symbolic ref\n",
    )
    assert await run(git_ws, "symbolic-ref -q refs/heads/main") == (1, "", "")


@pytest.mark.asyncio
async def test_pointing_head_logs_a_line_with_no_message(
    git_rw, repo_path: Path
):
    await run(git_rw, "branch other")
    before = len(log_lines(repo_path, "HEAD"))
    assert await run(git_rw, "symbolic-ref HEAD refs/heads/other") == (
        0,
        "",
        "",
    )
    assert (repo_path / ".git/HEAD").read_text() == "ref: refs/heads/other\n"
    lines = log_lines(repo_path, "HEAD")
    assert len(lines) == before + 1
    assert b"\t" not in lines[-1]
    assert lines[-1].endswith(b" +0000")


@pytest.mark.asyncio
async def test_a_reason_is_the_log_message(git_rw, repo_path: Path):
    await run(git_rw, "branch other")
    await run(git_rw, "symbolic-ref -m 'my msg' HEAD refs/heads/other")
    assert log_lines(repo_path, "HEAD")[-1].endswith(b"\tmy msg")
    assert await run(git_rw, "reflog -1") == (
        0,
        (await run(git_rw, "rev-parse --short HEAD"))[1].strip()
        + " HEAD@{0}: my msg\n",
        "",
    )


@pytest.mark.asyncio
async def test_an_empty_reason_is_refused(git_rw, repo_path: Path):
    assert await run(git_rw, "symbolic-ref -m '' HEAD refs/heads/main") == (
        128,
        "",
        "fatal: Refusing to perform update with empty message\n",
    )


@pytest.mark.asyncio
async def test_a_dangling_target_moves_head_without_a_log_line(
    git_rw, repo_path: Path
):
    before = log_lines(repo_path, "HEAD")
    assert await run(git_rw, "symbolic-ref HEAD refs/heads/unborn") == (
        0,
        "",
        "",
    )
    assert await run(git_rw, "symbolic-ref HEAD") == (
        0,
        "refs/heads/unborn\n",
        "",
    )
    assert log_lines(repo_path, "HEAD") == before


@pytest.mark.asyncio
async def test_only_branch_remote_and_notes_refs_gain_a_log(
    git_rw, repo_path: Path
):
    await run(git_rw, "symbolic-ref refs/heads/sym refs/heads/main")
    await run(git_rw, "symbolic-ref refs/other refs/heads/main")
    assert len(log_lines(repo_path, "refs", "heads", "sym")) == 1
    assert log_lines(repo_path, "refs", "heads", "sym")[0].startswith(
        b"0" * 40
    )
    assert log_lines(repo_path, "refs", "other") == []


@pytest.mark.asyncio
async def test_log_all_ref_updates_decides_which_refs_are_logged(
    git_rw, repo_path: Path
):
    config = repo_path / ".git/config"
    config.write_text(
        config.read_text() + "[core]\n\tlogAllRefUpdates = always\n"
    )
    await run(git_rw, "symbolic-ref refs/other refs/heads/main")
    assert len(log_lines(repo_path, "refs", "other")) == 1
    config.write_text(
        config.read_text() + "[core]\n\tlogAllRefUpdates = false\n"
    )
    await run(git_rw, "symbolic-ref refs/heads/sym refs/heads/main")
    assert log_lines(repo_path, "refs", "heads", "sym") == []


@pytest.mark.asyncio
async def test_recursion_follows_the_chain_unless_told_not_to(git_rw):
    await run(git_rw, "symbolic-ref refs/x refs/y")
    await run(git_rw, "symbolic-ref refs/y refs/heads/main")
    assert await run(git_rw, "symbolic-ref refs/x") == (
        0,
        "refs/heads/main\n",
        "",
    )
    assert await run(git_rw, "symbolic-ref --no-recurse refs/x") == (
        0,
        "refs/y\n",
        "",
    )
    assert await run(git_rw, "symbolic-ref --no-recurse --recurse refs/x") == (
        0,
        "refs/heads/main\n",
        "",
    )


@pytest.mark.asyncio
async def test_a_cycle_is_no_such_ref(git_rw):
    await run(git_rw, "symbolic-ref CYCLE_A CYCLE_B")
    await run(git_rw, "symbolic-ref CYCLE_B CYCLE_A")
    assert await run(git_rw, "symbolic-ref CYCLE_A") == (
        128,
        "",
        "fatal: No such ref: CYCLE_A\n",
    )


@pytest.mark.asyncio
async def test_delete_removes_the_ref_and_its_log(git_rw, repo_path: Path):
    await run(git_rw, "symbolic-ref refs/heads/sym refs/heads/main")
    assert await run(git_rw, "symbolic-ref -d refs/heads/sym") == (0, "", "")
    assert not (repo_path / ".git/refs/heads/sym").exists()
    assert not (repo_path / ".git/logs/refs/heads/sym").exists()
    assert await run(git_rw, "symbolic-ref -d HEAD") == (
        128,
        "",
        "fatal: deleting 'HEAD' is not allowed\n",
    )
    assert await run(git_rw, "symbolic-ref -d -q refs/heads/main") == (
        128,
        "",
        "fatal: Cannot delete refs/heads/main, not a symbolic ref\n",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "exit_code", "stderr"),
    [
        (
            "symbolic-ref HEAD main",
            128,
            "fatal: Refusing to point HEAD outside of refs/\n",
        ),
        (
            "symbolic-ref HEAD refs/heads/../x",
            128,
            "fatal: Refusing to set 'HEAD' to invalid ref 'refs/heads/../x'\n",
        ),
        (
            "symbolic-ref lower refs/heads/main",
            1,
            "error: refusing to update ref with bad name 'lower'\n",
        ),
        (
            "symbolic-ref refs/heads/main/x refs/heads/main",
            1,
            "error: cannot lock ref 'refs/heads/main/x': 'refs/heads/main' "
            "exists; cannot create 'refs/heads/main/x'\n",
        ),
    ],
)
async def test_a_refused_write_leaves_head_alone(
    git_rw, repo_path: Path, line: str, exit_code: int, stderr: str
):
    assert await run(git_rw, line) == (exit_code, "", stderr)
    assert (repo_path / ".git/HEAD").read_text() == "ref: refs/heads/main\n"


@pytest.mark.asyncio
async def test_a_wrong_operand_count_prints_the_usage(git_ws):
    code, out, err = await run(git_ws, "symbolic-ref a b c")
    assert (code, out) == (129, "")
    assert err.startswith(
        "usage: git symbolic-ref [-m <reason>] <name> <ref>\n"
    )
    assert err.endswith("    -m <reason>           reason of the update\n\n")


@pytest.mark.asyncio
async def test_a_read_only_mount_refuses_the_write(git_ws, repo_path: Path):
    code, _, _ = await run(git_ws, "symbolic-ref HEAD refs/heads/other")
    assert code == 1
    assert (repo_path / ".git/HEAD").read_text() == "ref: refs/heads/main\n"
