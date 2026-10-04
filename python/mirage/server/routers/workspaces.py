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

import hashlib
import io
import json
import tarfile
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response

from mirage import Workspace
from mirage.concurrency.limiter import run_blocking
from mirage.config import WorkspaceConfig, resolve_secrets
from mirage.secrets.errors import SecretsError
from mirage.server.clone import (
    build_override_mounts,
    clone_workspace_with_override,
)
from mirage.server.multipart import MAX_REQUEST_PART, PartEvent, part_events
from mirage.server.schemas import (
    CloneWorkspaceRequest,
    CreateWorkspaceRequest,
    DeleteWorkspaceResponse,
    LoadWorkspaceRequest,
    SnapshotWorkspaceRequest,
    SnapshotWorkspaceResponse,
    WorkspaceBrief,
    WorkspaceDetail,
)
from mirage.server.summary import make_brief, make_detail
from mirage.utils.ids import new_workspace_id
from mirage.vfs.s3.config import S3Config
from mirage.workspace.store import DiskWorkspaceStateStore
from mirage.workspace.store.disk import DOT_IDS

router = APIRouter(prefix="/v1/workspaces")


def _refuse_dot_id(workspace_id: str | None) -> None:
    """Refuse an id that would name the state root, not a workspace.

    Args:
        workspace_id (str | None): the id the request names, if any.
    """
    if workspace_id is not None and workspace_id in DOT_IDS:
        raise HTTPException(
            status_code=400, detail=f"invalid workspace id: {workspace_id!r}"
        )


def config_digest(config: WorkspaceConfig) -> str:
    """A stable fingerprint of the config a workspace was created from.

    Args:
        config (WorkspaceConfig): the config, its secret pointers unresolved.

    Returns:
        str: the SHA-256 of its canonical JSON.
    """
    canonical = json.dumps(config.model_dump(mode="json"), sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


@router.post("", response_model=WorkspaceDetail, status_code=201)
async def create_workspace(
    req: CreateWorkspaceRequest, request: Request, response: Response
) -> WorkspaceDetail:
    """Create a workspace, or answer the live one created from this config.

    Creating is idempotent for one config: an id already held by a
    workspace created from an identical config answers that workspace
    with 200, so a client that names its workspace can run again and
    reach it; an id held by anything else is refused with 409.

    Args:
        req (CreateWorkspaceRequest): the config and an optional id.
        request (Request): the HTTP request, for the app's registry.
        response (Response): the response, whose status a held id sets.

    Returns:
        WorkspaceDetail: the created or the matching live workspace.
    """
    registry = request.app.state.registry
    digest = config_digest(req.config)
    # The registry id and the state-store scope must be the same identity,
    # so resolve it before construction: explicit REST id, then the
    # config's workspace_id, then a fresh mint. A held id is answered or
    # refused here, before its secrets resolve or its mounts build, and
    # before a second Workspace opens the live one's state; one being
    # deleted is refused, since its state is about to go. Creates of one
    # id run one at a time, so a second of the same config answers what
    # the first built, and one of another config is refused at once.
    wid = (
        req.id
        if req.id is not None
        else req.config.workspace_id or new_workspace_id()
    )
    _refuse_dot_id(wid)
    async with registry.creating(wid, digest) as admitted:
        if not admitted:
            raise HTTPException(
                status_code=409,
                detail=f"workspace id already exists: {wid!r}",
            )
        if wid in registry:
            held = registry.get(wid)
            if registry.removing(wid) or held.config_digest != digest:
                raise HTTPException(
                    status_code=409,
                    detail=f"workspace id already exists: {wid!r}",
                )
            response.status_code = 200
            return await make_detail(held)
        try:
            # Map runtime entries construct their instances here, so a bad
            # entry (a wasi build dir that does not exist, an unknown
            # option) fails the create like any other config mistake.
            kwargs = (await resolve_secrets(req.config)).to_workspace_kwargs()
        except (
            FileNotFoundError,
            ImportError,
            SecretsError,
            ValueError,
            TypeError,
        ) as e:
            raise HTTPException(status_code=400, detail=str(e))
        kwargs["workspace_id"] = wid
        # Daemon default is disk (a created workspace survives restart with
        # zero infrastructure, like git init); the library default stays ram.
        # A config with an explicit store: block always wins.
        if "store" not in kwargs:
            kwargs["store"] = DiskWorkspaceStateStore(
                str(request.app.state.state_root)
            )
            kwargs["owns_store"] = True
        try:
            ws = Workspace(**kwargs)
        except (FileNotFoundError, ImportError, SecretsError, ValueError) as e:
            # Construction failures (a wasi build dir that does not exist, a
            # missing runtime extra, a `secrets:` block naming a source the
            # host cannot resolve) are the caller's to fix, not a 500.
            raise HTTPException(status_code=400, detail=str(e))
        try:
            for prefix, (
                backend,
                mountpoint,
            ) in req.config.kernel_mounts().items():
                await run_blocking(
                    ws.add_fuse_mount, prefix, mountpoint, backend=backend
                )
            entry = registry.add(ws, workspace_id=wid)
            entry.config_digest = digest
        except ValueError as e:
            await ws.close()
            raise HTTPException(status_code=409, detail=str(e))
        except Exception:
            await ws.close()
            raise
        return await make_detail(entry)


@router.get("", response_model=list[WorkspaceBrief])
async def list_workspaces(request: Request) -> list[WorkspaceBrief]:
    return [make_brief(e) for e in request.app.state.registry.list()]


@router.get("/{workspace_id}", response_model=WorkspaceDetail)
async def get_workspace(
    workspace_id: str, request: Request, verbose: bool = Query(False)
) -> WorkspaceDetail:
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    return await make_detail(registry.get(workspace_id), verbose=verbose)


@router.delete("/{workspace_id}", response_model=DeleteWorkspaceResponse)
async def delete_workspace(
    workspace_id: str, request: Request
) -> DeleteWorkspaceResponse:
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    try:
        await registry.remove(workspace_id)
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"workspace delete failed: {exc}"
        ) from exc
    return DeleteWorkspaceResponse(id=workspace_id, closed_at=time.time())


@router.post(
    "/{workspace_id}/clone", response_model=WorkspaceDetail, status_code=201
)
async def clone_workspace(
    workspace_id: str, req: CloneWorkspaceRequest, request: Request
) -> WorkspaceDetail:
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    _refuse_dot_id(req.id)
    if req.id is not None and req.id in registry:
        raise HTTPException(
            status_code=409, detail=f"workspace id already exists: {req.id!r}"
        )
    src_entry = registry.get(workspace_id)
    try:
        new_ws = await src_entry.runner.call(
            clone_workspace_with_override(src_entry.runner.ws, req.override)
        )
    except (SecretsError, ValueError) as e:
        # An override naming a source the host cannot resolve, or a
        # block the schema refuses, is the caller's mistake -- the
        # answer create, load and the historical clone already give.
        raise HTTPException(status_code=400, detail=str(e))
    try:
        entry = registry.add(new_ws, workspace_id=req.id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return await make_detail(entry)


@router.get("/{workspace_id}/snapshot")
async def download_snapshot(workspace_id: str, request: Request) -> Response:
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    entry = registry.get(workspace_id)
    buffer = io.BytesIO()
    await entry.runner.call(entry.runner.ws.snapshot(buffer))
    return Response(content=buffer.getvalue(), media_type="application/x-tar")


@router.post(
    "/{workspace_id}/snapshot", response_model=SnapshotWorkspaceResponse
)
async def snapshot_workspace(
    workspace_id: str, req: SnapshotWorkspaceRequest, request: Request
) -> SnapshotWorkspaceResponse:
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    store = _snapshot_store(request)
    entry = registry.get(workspace_id)
    size = await entry.runner.call(entry.runner.ws.snapshot(req.key, s3=store))
    return SnapshotWorkspaceResponse(id=workspace_id, key=req.key, size=size)


@router.post("/load", response_model=WorkspaceDetail, status_code=201)
async def load_workspace(request: Request) -> WorkspaceDetail:
    registry = request.app.state.registry
    content_type = request.headers.get("content-type", "")
    tar: bytes | None = None
    if content_type.startswith("multipart/"):
        req, tar = await _read_load_body(request, content_type)
    else:
        req = _parse_load_request(await request.body())
        if req.key is None:
            raise HTTPException(
                status_code=400,
                detail="load needs a 'key' or an uploaded 'snapshot' part",
            )
    _refuse_dot_id(req.id)
    if req.id is not None and req.id in registry:
        raise HTTPException(
            status_code=409, detail=f"workspace id already exists: {req.id!r}"
        )
    store: S3Config | None = None
    source: Any = io.BytesIO(tar) if tar is not None else req.key
    if tar is None:
        store = _snapshot_store(request)
    secrets = _build_load_secrets(req.override)
    try:
        # An override mount's credential may be a pointer at one of
        # these declarations; a container the constructor will reject
        # is left for it to reject.
        mounts = await build_override_mounts(req.override, secrets)
    except (KeyError, TypeError, ValueError, SecretsError) as e:
        # An override naming a VFS the daemon cannot build (an
        # unknown name, an unloadable ref, a ref that is not a VFS,
        # a secrets source it cannot resolve) is the caller's mistake,
        # the answer the TypeScript daemon gives too; it used to escape
        # as a 500.
        raise HTTPException(
            status_code=400, detail=f"override build failed: {e}"
        )
    try:
        ws = await Workspace.load(
            source, mounts=mounts, secrets=secrets, s3=store
        )
    except FileNotFoundError:
        raise HTTPException(
            status_code=400, detail=f"snapshot not found: {req.key}"
        )
    except (SecretsError, ValueError, tarfile.TarError, KeyError) as e:
        # A secrets override naming an unknown source, or one whose
        # optional dependency is absent, is a bad request like any
        # other override the deployment got wrong; so is an upload
        # that is not a snapshot.
        raise HTTPException(status_code=400, detail=f"load failed: {e}")
    try:
        entry = registry.add(ws, workspace_id=req.id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return await make_detail(entry)


def _snapshot_store(request: Request) -> S3Config:
    """The S3-like store the server was given for snapshots.

    Args:
        request (Request): the request, for the app's store.

    Returns:
        S3Config: the store.

    Raises:
        HTTPException: 400 when the server has none.
    """
    store: S3Config | None = request.app.state.snapshot_store
    if store is None:
        raise HTTPException(
            status_code=400, detail="this server has no snapshot store"
        )
    return store


def _parse_load_request(body: bytes) -> LoadWorkspaceRequest:
    try:
        return LoadWorkspaceRequest.model_validate(json.loads(body or b"{}"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"bad load request: {e}")


async def _read_load_body(
    request: Request, content_type: str
) -> tuple[LoadWorkspaceRequest, bytes]:
    """Read an uploaded snapshot: a ``request`` part, then the tar.

    The tar is held in memory, never spooled to the server's disk.

    Args:
        request (Request): the load request.
        content_type (str): its ``Content-Type`` header.

    Returns:
        tuple[LoadWorkspaceRequest, bytes]: the request and the tar.

    Raises:
        HTTPException: 400 for a body without both parts, or with a
            ``key``; 413 for an oversized request part.
    """
    name = b""
    body = bytearray()
    tar = bytearray()
    seen: set[bytes] = set()
    async for event, data in part_events(request.stream(), content_type):
        if event is PartEvent.BEGIN:
            name = data
            seen.add(name)
        elif event is PartEvent.DATA and name == b"request":
            body += data
            if len(body) > MAX_REQUEST_PART:
                raise HTTPException(
                    status_code=413, detail="request part too large"
                )
        elif event is PartEvent.DATA and name == b"snapshot":
            tar += data
    if b"snapshot" not in seen:
        raise HTTPException(
            status_code=400, detail="multipart body missing 'snapshot' part"
        )
    req = _parse_load_request(bytes(body))
    if req.key is not None:
        raise HTTPException(
            status_code=400,
            detail="load takes a 'key' or an uploaded 'snapshot', not both",
        )
    return req, bytes(tar)


def _build_load_secrets(
    override: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """The `secrets:` declarations a load override supplies.

    A snapshot never carries the block, because it is the deployment's
    credentials, so a restored pointer at a declared instance needs it
    named here -- the same reason a redacted mount needs `mounts`.
    """
    if not override:
        return None
    # Passed through as it arrived, even when it is not a mapping: the
    # constructor is the one place that judges the container, and
    # filtering here turned a bad override into a successful load whose
    # every restored pointer was unresolvable.
    return override.get("secrets")
