import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { getConfig, LOCAL_CALLBACK_URL } from '../lib/config.js';
import { McpTestStack } from '../lib/mcp-test-stack.js';

const stack = new McpTestStack(new cdk.App(), 'Test', {
  config: getConfig({}),
  env: { account: '123456789012', region: 'ap-northeast-1' },
});
const template = Template.fromStack(stack);
const expectedScope = {
  'Fn::Join': [
    '',
    [
      {
        Ref: Object.keys(
          template.findResources('AWS::Cognito::UserPoolResourceServer')
        )[0],
      },
      '/invoke',
    ],
  ],
};

describe('認証境界', () => {
  it('Web Functionはアプリ認証を使い、DCR状態を永続化する', () => {
    template.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
      AuthType: 'ApplicationManaged',
      EndpointType: 'HomeRegion',
      ScalingConfig: { MaxEnvironments: 2 },
      ThrottleConfig: { RateLimit: 100 },
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      KeySchema: [
        { AttributeName: 'collection', KeyType: 'HASH' },
        { AttributeName: 'key', KeyType: 'RANGE' },
      ],
    });
    template.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
      BuildConfig: Match.objectLike({
        RuntimeConfig: { Runtime: 'nodejs24.x' },
      }),
      ServiceConfig: Match.objectLike({
        EnvironmentVariables: Match.objectLike({
          AWS_LAMBDA_NODEJS_ENTRYPOINT: 'index.mjs',
        }),
      }),
    });
  });
  it('ProxyのURL・クライアントID・Gateway URLはSSM Parameterから読む', () => {
    const [revision] = Object.values(
      template.findResources('AWS::Lambda::WebFunctionRevision')
    );
    const env = revision.Properties.ServiceConfig.EnvironmentVariables;
    expect(env.CONFIG_PARAMETER).toBe('/dev-muse-mcp/oauth-proxy/config');
    for (const name of ['BASE_URL', 'GATEWAY_URL', 'COGNITO_CLIENT_ID'])
      expect(env).not.toHaveProperty(name);
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/dev-muse-mcp/oauth-proxy/config',
      Type: 'String',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: [
        {
          'Fn::Join': [
            '',
            [
              'https://',
              {
                'Fn::GetAtt': [
                  Match.stringLikeRegexp('^OAuthProxyEndpoint'),
                  'DomainName',
                ],
              },
              '/auth/callback',
            ],
          ],
        },
      ],
    });
  });
  it('4ツールを認証ありのGateway1つだけに公開する', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
    template.resourceCountIs('AWS::Lambda::WebFunction', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
    const targets = Object.values(
      template.findResources('AWS::BedrockAgentCore::GatewayTarget')
    );
    expect(targets).toHaveLength(1);
    const [target] = targets;
    expect(
      target.Properties.TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload.map(
        (tool: { Name: string }) => tool.Name
      )
    ).toEqual([
      'search_available_rooms',
      'create_reservation',
      'list_reservations',
      'cancel_reservation',
    ]);
    expect(target.Properties.CredentialProviderConfigurations).toEqual([
      { CredentialProviderType: 'GATEWAY_IAM_ROLE' },
    ]);
    template.resourceCountIs('AWS::DSQL::Cluster', 1);
    const functions = Object.values(
      template.findResources('AWS::Lambda::Function')
    ).filter((fn) => fn.Properties.Environment?.Variables?.BOOKING_SCHEMA);
    expect(
      functions.map((fn) => fn.Properties.Environment.Variables.BOOKING_SCHEMA)
    ).toEqual(['booking_auth']);
  });

  it('Gatewayはclient・scope・token_useを検証する', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerType: 'CUSTOM_JWT',
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: {
          DiscoveryUrl: Match.anyValue(),
          AllowedClients: [
            { Ref: Match.anyValue() },
            { Ref: Match.anyValue() },
          ],
          AllowedScopes: [expectedScope],
          CustomClaims: [
            {
              InboundTokenClaimName: 'token_use',
              InboundTokenClaimValueType: 'STRING',
              AuthorizingClaimMatchValue: {
                ClaimMatchOperator: 'EQUALS',
                ClaimMatchValue: { MatchValueString: 'access' },
              },
            },
          ],
        },
      },
    });
  });

  it('Cognitoはsecretなしの認可コードフローと手動登録ユーザーに限定する', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['openid', expectedScope],
      CallbackURLs: [LOCAL_CALLBACK_URL],
      AccessTokenValidity: 15,
    });
  });

  it('Gatewayのロールは自アカウントの該当Gatewayと対応Lambdaに限定する', () => {
    const roles = Object.entries(
      template.findResources('AWS::IAM::Role')
    ).filter(([id]) => id.includes('GatewayRole'));
    expect(roles).toHaveLength(1);
    for (const [, role] of roles) {
      expect(role.Properties.AssumeRolePolicyDocument.Statement).toHaveLength(
        1
      );
      expect(
        role.Properties.AssumeRolePolicyDocument.Statement[0]
      ).toMatchObject({
        Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
        Condition: {
          StringEquals: { 'aws:SourceAccount': '123456789012' },
          ArnLike: { 'aws:SourceArn': expect.anything() },
        },
      });
    }
    const policies = Object.entries(
      template.findResources('AWS::IAM::Policy')
    ).filter(([id]) => id.includes('InvokeTool'));
    expect(policies).toHaveLength(1);
    for (const [, policy] of policies) {
      expect(policy.Properties.PolicyDocument.Statement).toEqual([
        {
          Action: 'lambda:InvokeFunction',
          Effect: 'Allow',
          Resource: {
            'Fn::GetAtt': [
              expect.stringMatching(/^AuthenticatedBooking/),
              'Arn',
            ],
          },
        },
      ]);
    }
  });

  it('実験用スタックにWAFを作らず、Lambdaの同時実行を制限する', () => {
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    for (const gateway of Object.values(
      template.findResources('AWS::BedrockAgentCore::Gateway')
    )) {
      expect(gateway.Properties.WafConfiguration).toBeUndefined();
    }
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 2,
      Timeout: 30,
    });
  });

  it('Lambdaは対象DSQLへの一般接続のみ許可し、管理接続を持たない', () => {
    const policies = Object.entries(
      template.findResources('AWS::IAM::Policy')
    ).filter(([id]) => /ToolRoleDefaultPolicy/.test(id));
    expect(policies).toHaveLength(1);
    for (const [, policy] of policies) {
      expect(policy.Properties.PolicyDocument.Statement).toContainEqual({
        Action: 'dsql:DbConnect',
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': ['BookingDatabase', 'ResourceArn'] },
      });
      expect(JSON.stringify(policy)).not.toContain('dsql:DbConnectAdmin');
    }
  });

  it('理由を記録した例外以外にcdk-nagの違反がない', () => {
    const report = new AwsSolutionsChecks(undefined, {
      verbose: true,
    }).validateScope(stack);
    expect(report.violations).toEqual([]);
  });
});

describe('設定', () => {
  it('追加コールバックとローカル検証用コールバックを併存させる', () => {
    expect(
      getConfig({
        additionalCallbackUrls: 'https://example.com/oauth/callback',
      }).callbackUrls
    ).toEqual([LOCAL_CALLBACK_URL, 'https://example.com/oauth/callback']);
  });
  it.each([
    'http://example.com/callback',
    'https://example.com/cb#fragment',
    'https://user:pass@example.com/cb',
    'https://example.com/*',
  ])('不正なcallbackを拒否する: %s', (url) => {
    expect(() => getConfig({ additionalCallbackUrls: url })).toThrow();
  });
});
