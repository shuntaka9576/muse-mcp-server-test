"""DCR-facing MCP proxy; Cognito tokens remain on the server side."""

from dataclasses import dataclass
from urllib.parse import urlsplit

from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.server.auth.oidc_proxy import OIDCProxy
from fastmcp.server.auth.providers.jwt import JWTVerifier
from fastmcp.server.dependencies import get_access_token
from fastmcp.server.providers.proxy import FastMCPProxy, ProxyClient
from key_value.aio.protocols.key_value import AsyncKeyValue


@dataclass(frozen=True)
class Config:
    base_url: str
    gateway_url: str
    issuer: str
    client_id: str
    scope: str

    def __post_init__(self):
        for value in (self.base_url, self.gateway_url, self.issuer):
            url = urlsplit(value)
            if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
                raise ValueError("Proxy, Gateway and issuer URLs must be absolute HTTPS URLs")


class CognitoAccessTokenVerifier(JWTVerifier):
    def __init__(self, config: Config):
        super().__init__(
            jwks_uri=f"{config.issuer}/.well-known/jwks.json",
            issuer=config.issuer,
            algorithm="RS256",
            required_scopes=[config.scope],
        )
        self.expected_client_id = config.client_id
        self.expected_resource = config.gateway_url

    async def verify_token(self, token: str):
        verified = await super().verify_token(token)
        if verified is None:
            return None
        if verified.claims.get("token_use") != "access" or verified.claims.get("client_id") != self.expected_client_id:
            return None
        # Classic Cognito hosted login issues access tokens without aud. Bind
        # those to our dedicated app client and scope. If resource binding is
        # present, also enforce it. The proxy-issued JWT always binds to /mcp.
        audience = verified.claims.get("aud")
        if audience is not None and self.expected_resource not in (audience if isinstance(audience, list) else [audience]):
            return None
        return verified


def build_proxy(config: Config, storage: AsyncKeyValue, signing_key: bytes):
    auth = OIDCProxy(
        config_url=f"{config.issuer}/.well-known/openid-configuration",
        client_id=config.client_id,
        client_secret=None,
        token_endpoint_auth_method="none",
        token_verifier=CognitoAccessTokenVerifier(config),
        base_url=config.base_url,
        redirect_path="/auth/callback",
        valid_scopes=[config.scope],
        client_storage=storage,
        jwt_signing_key=signing_key,
        enable_cimd=False,
        require_authorization_consent=True,
        # The upstream access token is issued for this Gateway, not for the
        # public proxy URL supplied by the MCP client.
        forward_resource=False,
        extra_authorize_params={"scope": f"openid {config.scope}", "resource": config.gateway_url},
        extra_token_params={"resource": config.gateway_url},
        allowed_client_redirect_uris=[
            "https://agent.meta.ai/*",
            "https://muse.ai/*",
            "https://*.muse.ai/*",
            "http://localhost:*/callback",
            "http://127.0.0.1:*/callback",
        ],
    )

    def upstream_client():
        # OAuthProxy verifies its own JWT and resolves it to the verified
        # upstream Cognito access token before establishing this context.
        token = get_access_token()
        if token is None:
            raise PermissionError("Authentication is required")
        return ProxyClient(
            StreamableHttpTransport(config.gateway_url, auth=token.token),
            forward_incoming_headers=False,
        )

    proxy = FastMCPProxy(
        name="Muse meeting room booking (DCR)",
        client_factory=upstream_client,
        auth=auth,
        provider_error_strategy="raise",
    )
    return proxy


def http_app(proxy):
    # OAuth state lives in DynamoDB, so any Web Function environment can serve it.
    return proxy.http_app(path="/mcp", stateless_http=True, json_response=True)
