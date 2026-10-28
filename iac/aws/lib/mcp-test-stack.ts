import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dsql from 'aws-cdk-lib/aws-dsql';
import { toolDefinitions } from './tool-definitions.js';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { LOCAL_CALLBACK_URL, type Config } from './config.js';
import { acknowledge } from './nag.js';
import { OAuthProxy } from './oauth-proxy.js';

export interface McpTestStackProps extends cdk.StackProps {
  config: Config;
}

export class McpTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: McpTestStackProps) {
    super(scope, id, props);
    const { prefix, callbackUrls } = props.config;

    const cluster = new dsql.CfnCluster(this, 'BookingDatabase', {
      deletionProtectionEnabled: false,
      tags: [{ key: 'Name', value: `${prefix}-booking` }],
    });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    const tools = {} as Record<
      'Public' | 'Authenticated',
      nodejs.NodejsFunction
    >;
    for (const kind of ['Public', 'Authenticated'] as const) {
      const schema = kind === 'Public' ? 'booking_noauth' : 'booking_auth';
      const logGroup = new logs.LogGroup(this, `${kind}ToolLogs`, {
        logGroupName: `/aws/lambda/${prefix}-${schema}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const role = new iam.Role(this, `${kind}ToolRole`, {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      const logGrant = logGroup.grantWrite(role);
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['dsql:DbConnect'],
          resources: [cluster.attrResourceArn],
        })
      );
      const tool = new nodejs.NodejsFunction(this, `${kind}Booking`, {
        functionName: `${prefix}-${schema}`,
        entry: fileURLToPath(
          new URL('../../../apps/mcp-tools/src/index.ts', import.meta.url)
        ),
        depsLockFilePath: fileURLToPath(
          new URL('../../../bun.lock', import.meta.url)
        ),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: cdk.Duration.seconds(30),
        reservedConcurrentExecutions: 2,
        role,
        logGroup,
        loggingFormat: lambda.LoggingFormat.JSON,
        environment: {
          DSQL_ENDPOINT: cluster.attrEndpoint,
          DSQL_USER: schema,
          BOOKING_SCHEMA: schema,
        },
        bundling: {
          format: nodejs.OutputFormat.CJS,
          target: 'node24',
          minify: true,
          externalModules: ['pg-native'],
        },
      });
      logGrant.applyBefore(tool);
      acknowledge(
        role,
        `AwsSolutions-IAM5[Resource::<${this.getLogicalId(logGroup.node.defaultChild as cdk.CfnResource)}.Arn>:*]`,
        'ログストリームは実行時に生成されるため、専用LogGroup内に限定して許可する。'
      );
      tools[kind] = tool;
      new cdk.CfnOutput(this, `${kind}ToolRoleArn`, { value: role.roleArn });
      new cdk.CfnOutput(this, `${kind}ToolFunctionName`, {
        value: tool.functionName,
      });
      new cdk.CfnOutput(this, `${kind}ToolLogGroup`, {
        value: logGroup.logGroupName,
      });
    }
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: cluster.attrEndpoint,
    });
    new cdk.CfnOutput(this, 'DatabaseClusterId', {
      value: cluster.attrIdentifier,
    });
    new cdk.CfnOutput(this, 'Region', { value: this.region });

    const pool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefix}-users`,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });
    const invokeScope = new cognito.ResourceServerScope({
      scopeName: 'invoke',
      scopeDescription: 'Invoke the meeting room booking MCP tools',
    });
    const resourceServer = pool.addResourceServer('McpResourceServer', {
      identifier: prefix,
      scopes: [invokeScope],
    });
    const oauthScope = cognito.OAuthScope.resourceServer(
      resourceServer,
      invokeScope
    );
    const client = pool.addClient('McpClient', {
      userPoolClientName: `${prefix}-pkce`,
      generateSecret: false,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, oauthScope],
        callbackUrls,
      },
      accessTokenValidity: cdk.Duration.minutes(15),
      idTokenValidity: cdk.Duration.minutes(15),
      refreshTokenValidity: cdk.Duration.hours(1),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });
    client.node.addDependency(resourceServer);
    const domain = pool.addDomain('LoginDomain', {
      cognitoDomain: {
        domainPrefix: `${prefix}-${this.account}-${this.region}`,
      },
    });
    const issuer = `https://cognito-idp.${this.region}.${this.urlSuffix}/${pool.userPoolId}`;
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
    acknowledge(
      pool,
      'AwsSolutions-COG2',
      '架空の会議室データを扱う検証専用ユーザープール。手動作成ユーザーだけを許可し、今回はMFAを設定しない。'
    );
    acknowledge(
      pool,
      'AwsSolutions-COG3',
      '会議室予約のOAuth検証用で、Cognitoの高度なセキュリティ機能は利用しない。'
    );
    acknowledge(
      pool,
      'AwsSolutions-COG8',
      '検証終了後にユーザーごと削除するため、削除保護を設定しない。'
    );

    const createGateway = (
      kind: 'Public' | 'Authenticated'
    ): agentcore.CfnGateway => {
      const tool = tools[kind];
      const gatewayName = `${prefix}-${kind.toLowerCase()}`;
      const role = new iam.Role(this, `${kind}GatewayRole`, {
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
          conditions: {
            StringEquals: { 'aws:SourceAccount': this.account },
            // Gateway IDは作成後に決まるため、名前の接頭辞で循環依存を避ける。
            ArnLike: {
              'aws:SourceArn': this.formatArn({
                service: 'bedrock-agentcore',
                resource: 'gateway',
                resourceName: `${gatewayName}-*`,
              }),
            },
          },
        }),
      });
      const invokePolicy = new iam.Policy(this, `${kind}InvokeTool`, {
        roles: [role],
        statements: [
          new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: [tool.functionArn],
          }),
        ],
      });
      const gateway = new agentcore.CfnGateway(this, `${kind}Gateway`, {
        name: gatewayName,
        description: `${kind} endpoint for the Muse meeting room booking test`,
        protocolType: 'MCP',
        protocolConfiguration: {
          mcp: {
            supportedVersions: [
              '2025-03-26',
              '2025-06-18',
              '2025-11-25',
              '2026-07-28',
            ],
            instructions:
              'Search, create, list, and cancel fictional meeting room reservations. Interpret dates in Asia/Tokyo. Confirm writes with the user and check ok before reporting success.',
          },
        },
        authorizerType: kind === 'Public' ? 'NONE' : 'CUSTOM_JWT',
        authorizerConfiguration:
          kind === 'Public'
            ? undefined
            : {
                customJwtAuthorizer: {
                  discoveryUrl,
                  allowedClients: [
                    client.userPoolClientId,
                    proxyClient.userPoolClientId,
                  ],
                  allowedScopes: [oauthScope.scopeName],
                  customClaims: [
                    {
                      inboundTokenClaimName: 'token_use',
                      inboundTokenClaimValueType: 'STRING',
                      authorizingClaimMatchValue: {
                        claimMatchOperator: 'EQUALS',
                        claimMatchValue: { matchValueString: 'access' },
                      },
                    },
                  ],
                },
              },
        roleArn: role.roleArn,
      });
      gateway.node.addDependency(invokePolicy);
      if (kind === 'Authenticated') gateway.node.addDependency(domain);
      const target = new agentcore.CfnGatewayTarget(
        this,
        `${kind}BookingTarget`,
        {
          gatewayIdentifier: gateway.attrGatewayIdentifier,
          name: 'booking',
          description:
            'Fictional meeting room reservations isolated by authentication mode',
          credentialProviderConfigurations: [
            { credentialProviderType: 'GATEWAY_IAM_ROLE' },
          ],
          targetConfiguration: {
            mcp: {
              lambda: {
                lambdaArn: tool.functionArn,
                toolSchema: { inlinePayload: toolDefinitions },
              },
            },
          },
        }
      );
      target.node.addDependency(invokePolicy);
      return gateway;
    };
    const oauthProxy = new OAuthProxy(this, 'OAuthProxy', {
      prefix,
      issuer,
      scope: oauthScope.scopeName,
    });
    // ProxyのURLはEndpointの作成後に決まるため、Endpointを作ってからクライアントを登録する。
    const proxyClient = pool.addClient('ProxyClient', {
      userPoolClientName: `${prefix}-proxy-pkce`,
      generateSecret: false,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, oauthScope],
        callbackUrls: [`${oauthProxy.baseUrl}/auth/callback`],
      },
      accessTokenValidity: cdk.Duration.minutes(15),
      idTokenValidity: cdk.Duration.minutes(15),
      refreshTokenValidity: cdk.Duration.hours(1),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });
    proxyClient.node.addDependency(resourceServer);
    const publicGateway = createGateway('Public');
    const authenticatedGateway = createGateway('Authenticated');
    // これらの値をRevisionの環境変数に渡すと、Revision → Gateway → Cognitoクライアント
    // → Endpoint → Revisionと循環する。SSM Parameterに置き、Proxyが起動時に読む。
    new ssm.StringParameter(this, 'OAuthProxyConfig', {
      parameterName: oauthProxy.configParameterName,
      stringValue: this.toJsonString({
        baseUrl: oauthProxy.baseUrl,
        gatewayUrl: authenticatedGateway.attrGatewayUrl,
        clientId: proxyClient.userPoolClientId,
      }),
    });

    const outputs: Record<string, string> = {
      PublicGatewayUrl: publicGateway.attrGatewayUrl,
      AuthenticatedGatewayUrl: authenticatedGateway.attrGatewayUrl,
      UserPoolId: pool.userPoolId,
      ClientId: client.userPoolClientId,
      ProxyClientId: proxyClient.userPoolClientId,
      DiscoveryUrl: discoveryUrl,
      AuthorizationEndpoint: `${domain.baseUrl()}/oauth2/authorize`,
      TokenEndpoint: `${domain.baseUrl()}/oauth2/token`,
      Scope: oauthScope.scopeName,
      LocalCallbackUrl: LOCAL_CALLBACK_URL,
      CallbackUrls: callbackUrls.join(','),
    };
    for (const [key, value] of Object.entries(outputs))
      new cdk.CfnOutput(this, key, { value });
  }
}
