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

import os

from httpx._utils import peek_filelike_length

from mirage.cli import shell


def test_piped_stdin_is_sent_without_a_size(monkeypatch):
    read, write = os.pipe()
    os.write(write, b"only what is buffered so far")
    with os.fdopen(read, "rb") as pipe:
        monkeypatch.setattr(
            shell.sys, "stdin", type("Stdin", (), {"buffer": pipe})()
        )
        part = shell._upload({"command": "cat"})["stdin"][1]
        assert peek_filelike_length(part) is None
        assert part.read(4) == b"only"
    os.close(write)
