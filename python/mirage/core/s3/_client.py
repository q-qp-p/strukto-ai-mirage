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

import aioboto3
from botocore.config import Config

from mirage.accessor.s3 import S3Config
from mirage.utils import key_prefix as kp


def _key(path: str, config: S3Config) -> str:
    return kp.apply(config.key_prefix or "", path)


def _prefix(path: str, config: S3Config) -> str:
    return kp.apply_dir(config.key_prefix or "", path)


def _strip_prefix(key: str, config: S3Config) -> str:
    return kp.strip(config.key_prefix or "", key)


def _client_kwargs(config: S3Config) -> dict:
    kwargs: dict = {"service_name": "s3"}
    if config.region:
        kwargs["region_name"] = config.region
    if config.endpoint_url:
        kwargs["endpoint_url"] = config.endpoint_url
    if config.aws_access_key_id and config.aws_secret_access_key:
        kwargs["aws_access_key_id"] = config.aws_access_key_id
        kwargs["aws_secret_access_key"] = config.aws_secret_access_key
    if config.aws_session_token:
        kwargs["aws_session_token"] = config.aws_session_token
    cfg_kwargs: dict = {
        "connect_timeout": config.timeout,
        "read_timeout": config.timeout,
    }
    if config.proxy:
        cfg_kwargs["proxies"] = {"https": config.proxy, "http": config.proxy}
    if config.path_style:
        cfg_kwargs["s3"] = {"addressing_style": "path"}
    kwargs["config"] = Config(**cfg_kwargs)
    return kwargs


def async_session(config: S3Config) -> aioboto3.Session:
    return aioboto3.Session(profile_name=config.aws_profile or None)
