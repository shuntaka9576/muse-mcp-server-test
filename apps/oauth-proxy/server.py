"""Persistent ASGI server for Lambda Web Functions."""

import base64
import hashlib
import json
import logging
import os
import time

import boto3
import uvicorn
from cryptography.fernet import Fernet
from key_value.aio.stores.dynamodb import DynamoDBStore
from key_value.aio.wrappers.encryption import FernetEncryptionWrapper

from proxy_app import Config, build_proxy, http_app

logging.basicConfig(level=logging.WARNING)


def read_config(region):
    # CloudFormation creates this parameter after the endpoint, so an
    # environment started during the first deployment may briefly miss it.
    ssm = boto3.client("ssm", region_name=region)
    for _ in range(15):
        try:
            value = ssm.get_parameter(Name=os.environ["CONFIG_PARAMETER"])["Parameter"]["Value"]
            return json.loads(value)
        except ssm.exceptions.ParameterNotFound:
            time.sleep(2)
    raise RuntimeError("OAuth proxy configuration parameter was not found")


def create_app():
    config = read_config(os.environ["APP_AWS_REGION"])
    secret = boto3.client("secretsmanager", region_name=os.environ["APP_AWS_REGION"]).get_secret_value(
        SecretId=os.environ["KEY_SECRET_ARN"]
    )["SecretString"].encode()
    storage = FernetEncryptionWrapper(
        key_value=DynamoDBStore(
            table_name=os.environ["TOKEN_TABLE"],
            region_name=os.environ["APP_AWS_REGION"],
            auto_create=False,
        ),
        fernet=Fernet(base64.urlsafe_b64encode(hashlib.sha256(b"storage\0" + secret).digest())),
    )
    proxy = build_proxy(
        Config(
            base_url=config["baseUrl"],
            gateway_url=config["gatewayUrl"],
            issuer=os.environ["COGNITO_ISSUER"],
            client_id=config["clientId"],
            scope=os.environ["MCP_SCOPE"],
        ),
        storage,
        hashlib.sha256(b"jwt\0" + secret).digest(),
    )
    return http_app(proxy)


if __name__ == "__main__":
    host, port = os.environ.get("AWS_LAMBDA_HTTP_ENDPOINT", "127.0.0.1:8000").rsplit(":", 1)
    uvicorn.run(create_app(), host=host, port=int(port), access_log=False, log_level="warning")
