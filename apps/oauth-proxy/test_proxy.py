import base64
import hashlib
import sys
from pathlib import Path

import pytest
from fastmcp.server.auth.oidc_proxy import OIDCConfiguration, OIDCProxy
from fastmcp.server.auth.providers.jwt import JWTVerifier, RSAKeyPair
from key_value.aio.stores.memory import MemoryStore
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))
from proxy_app import Config, CognitoAccessTokenVerifier, build_proxy, http_app

CONFIG = Config("https://proxy.example.com", "https://gateway.example.com/mcp", "https://issuer.example.com", "cognito-client", "booking/invoke")


@pytest.fixture
def proxy(monkeypatch):
    monkeypatch.setattr(OIDCProxy, "get_oidc_configuration", lambda *a, **kw: OIDCConfiguration(
        issuer=CONFIG.issuer,
        authorization_endpoint=f"{CONFIG.issuer}/authorize",
        token_endpoint=f"{CONFIG.issuer}/token",
        jwks_uri=f"{CONFIG.issuer}/jwks.json",
        response_types_supported=["code"],
        subject_types_supported=["public"],
        id_token_signing_alg_values_supported=["RS256"],
        token_endpoint_auth_methods_supported=["none"],
        scopes_supported=["openid", CONFIG.scope],
    ))
    return build_proxy(CONFIG, MemoryStore(), b"unit-test-key-not-for-production!")


def register(client, redirect="http://localhost:8765/callback"):
    return client.post("/register", json={
        "client_name": "DCR integration test",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": CONFIG.scope,
    })


def test_discovery_and_unauthenticated_mcp(proxy):
    with TestClient(http_app(proxy), base_url=CONFIG.base_url) as client:
        metadata = client.get("/.well-known/oauth-authorization-server").json()
        assert metadata["registration_endpoint"] == f"{CONFIG.base_url}/register"
        assert metadata["code_challenge_methods_supported"] == ["S256"]
        assert not metadata.get("client_id_metadata_document_supported", False)
        response = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert response.status_code == 401
        assert "resource_metadata=" in response.headers["www-authenticate"]


def test_registration_and_pkce_required(proxy):
    with TestClient(http_app(proxy), base_url=CONFIG.base_url) as client:
        result = register(client)
        assert result.status_code == 201, result.text
        data = result.json()
        assert data["client_id"]
        assert data.get("token_endpoint_auth_method") == "none"
        params = {"client_id": data["client_id"], "redirect_uri": "http://localhost:8765/callback", "response_type": "code", "scope": CONFIG.scope, "state": "state-for-test"}
        missing = client.get("/authorize", params=params, follow_redirects=False)
        assert missing.status_code in (302, 400)
        assert "invalid_request" in missing.text + missing.headers.get("location", "")
        params.update(code_challenge=base64.urlsafe_b64encode(hashlib.sha256(b"x" * 64).digest()).decode().rstrip("="), code_challenge_method="S256")
        valid = client.get("/authorize", params=params, follow_redirects=False)
        assert valid.status_code in (200, 302), valid.text


def test_untrusted_redirect_rejected(proxy):
    with TestClient(http_app(proxy), base_url=CONFIG.base_url) as client:
        result = register(client, "https://untrusted.example.com/callback")
        assert result.status_code == 400


@pytest.mark.asyncio
async def test_cognito_claims_and_signature():
    keys = RSAKeyPair.generate()
    verifier = CognitoAccessTokenVerifier(CONFIG)
    # Use a local test key with the same production issuer/audience/scope rules.
    JWTVerifier.__init__(verifier, public_key=keys.public_key, issuer=CONFIG.issuer,
                         algorithm="RS256", required_scopes=[CONFIG.scope])
    def token(**changes):
        values = dict(issuer=CONFIG.issuer, audience=CONFIG.gateway_url, scopes=[CONFIG.scope], additional_claims={"token_use": "access", "client_id": CONFIG.client_id})
        values.update(changes)
        return keys.create_token(**values)
    assert await verifier.verify_token(token()) is not None
    assert await verifier.verify_token(token(audience=None)) is not None
    for bad in [
        token(audience="https://another-resource.example.com"),
        token(issuer="https://another-issuer.example.com"),
        token(scopes=["openid"]),
        token(expires_in_seconds=-60),
        token(additional_claims={"token_use": "id", "client_id": CONFIG.client_id}),
        token(additional_claims={"token_use": "access", "client_id": "another-client"}),
        token()[:-8] + "invalidx",
    ]:
        assert await verifier.verify_token(bad) is None
