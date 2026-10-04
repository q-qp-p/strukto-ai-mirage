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

import io
from collections.abc import Iterator

import boto3
import pytest
from moto.server import ThreadedMotoServer

from mirage import MountMode, Workspace
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3.config import S3Config

CREDS = dict(
    aws_access_key_id="testing",
    aws_secret_access_key="testing",
    region_name="us-east-1",
)


@pytest.fixture()
def store() -> Iterator[S3Config]:
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    boto3.client("s3", endpoint_url=endpoint, **CREDS).create_bucket(
        Bucket="snaps"
    )
    yield S3Config(
        bucket="snaps",
        region="us-east-1",
        endpoint_url=endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        path_style=True,
        key_prefix="team/",
    )
    server.stop()


async def _written() -> Workspace:
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    await ws.shell("echo kept > /f")
    return ws


async def _cat(ws: Workspace) -> str:
    return await (await ws.shell("cat /f")).stdout_str()


@pytest.mark.asyncio
async def test_a_snapshot_round_trips_through_bytes():
    buffer = io.BytesIO()
    size = await (await _written()).snapshot(buffer)
    assert size == len(buffer.getvalue()) > 0
    buffer.seek(0)
    assert await _cat(await Workspace.load(buffer)) == "kept\n"


@pytest.mark.asyncio
async def test_a_snapshot_round_trips_through_an_s3_store(store):
    size = await (await _written()).snapshot("a.tar", s3=store)
    head = boto3.client(
        "s3", endpoint_url=store.endpoint_url, **CREDS
    ).head_object(Bucket="snaps", Key="team/a.tar")
    assert head["ContentLength"] == size
    assert await _cat(await Workspace.load("a.tar", s3=store)) == "kept\n"


@pytest.mark.asyncio
async def test_a_missing_key_is_file_not_found(store):
    with pytest.raises(FileNotFoundError):
        await Workspace.load("nope.tar", s3=store)
