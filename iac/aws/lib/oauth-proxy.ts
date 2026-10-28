import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { acknowledge } from './nag.js';

export class OAuthProxy extends Construct {
  readonly endpoint: lambda.CfnWebFunctionEndpoint;
  readonly baseUrl: string;
  /** ProxyのURL・CognitoクライアントID・Gateway URLを入れるSSM Parameterの名前 */
  readonly configParameterName: string;

  constructor(
    scope: Construct,
    id: string,
    props: {
      prefix: string;
      issuer: string;
      scope: string;
    }
  ) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const name = `${props.prefix}-oauth-proxy`;
    this.configParameterName = `/${props.prefix}/oauth-proxy/config`;
    const table = new dynamodb.Table(this, 'Tokens', {
      partitionKey: { name: 'collection', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const key = new secretsmanager.Secret(this, 'Key', {
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });
    acknowledge(
      key,
      'AwsSolutions-SMG4',
      '検証用の署名・暗号化鍵。自動ローテーションによる既存セッションの失効を避け、検証終了時に削除する。'
    );
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    table.grantReadWriteData(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:DescribeTimeToLive'],
        resources: [table.tableArn],
      })
    );
    key.grantRead(role);
    // Parameterリソースを参照すると循環するため、名前からARNを組み立てる。
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          stack.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: this.configParameterName.slice(1),
          }),
        ],
      })
    );
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/lambda-web/${name}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const localLogGroup = new logs.LogGroup(this, 'LocalLogs', {
      logGroupName: `${logGroup.logGroupName}.local`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    for (const group of [logGroup, localLogGroup]) {
      group.grantWrite(role);
      acknowledge(
        role,
        `AwsSolutions-IAM5[Resource::<${stack.getLogicalId(group.node.defaultChild as cdk.CfnResource)}.Arn>:*]`,
        '実行時に作るログストリームを、このProxy専用LogGroup内に限定する。'
      );
    }
    const bucket = new s3.Bucket(this, 'Code', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    acknowledge(
      bucket,
      'AwsSolutions-S1',
      'コード配布専用。コードは非公開とし、バージョンを保持する。検証用に別のアクセスログ用バケットは作らない。'
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [bucket.arnForObjects('*')],
        conditions: {
          ArnLike: {
            'aws:SourceArn': stack.formatArn({
              service: 'lambda',
              resource: 'web-function',
              resourceName: `${name}/revision/*`,
            }),
          },
        },
      })
    );
    const code = new s3deploy.BucketDeployment(this, 'DeployCode', {
      sources: [
        s3deploy.Source.asset(
          fileURLToPath(
            new URL('../../../.local/oauth-proxy-web.zip', import.meta.url)
          )
        ),
      ],
      destinationBucket: bucket,
      extract: false,
      prune: false,
    });
    // The CDK-owned provider uses its bundled runtime/layer and generated S3
    // permissions. Keep these exceptions limited to that provider.
    for (const provider of stack.node.children.filter((child) =>
      child.node.id.startsWith('Custom::CDKBucketDeployment')
    )) {
      acknowledge(
        provider,
        'AwsSolutions-L1',
        'CDK BucketDeployment同梱のPythonランタイムとレイヤーを組み合わせて使用する。アプリの実行環境ではない。'
      );
      acknowledge(
        provider,
        'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
        'CDKのコード配布用Custom Resourceが自分のログを出力するために使用する。'
      );
      for (const action of [
        's3:GetObject*',
        's3:GetBucket*',
        's3:List*',
        's3:DeleteObject*',
        's3:Abort*',
      ]) {
        acknowledge(
          provider,
          `AwsSolutions-IAM5[Action::${action}]`,
          'CDKが生成するコードZIP配布用の権限。配布元bootstrapバケットと配布先の専用バケットに限定し、prune=falseで旧コードを保持する。'
        );
      }
      acknowledge(
        provider,
        `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-${stack.account}-${stack.region}/*]`,
        'CDK bootstrapから生成されたコードZIPを読み込むためのCDK標準権限。'
      );
      acknowledge(
        provider,
        `AwsSolutions-IAM5[Resource::<${stack.getLogicalId(bucket.node.defaultChild as cdk.CfnResource)}.Arn>/*]`,
        'コードZIPのハッシュ名とバージョンがビルドごとに変わるため、配布先の専用バケット内に限定して許可する。'
      );
    }
    const fn = new lambda.CfnWebFunction(this, 'Function', {
      functionName: name,
    });
    const revision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
      functionName: fn.attrFunctionArn,
      buildConfig: {
        codeConfig: {
          s3Object: {
            bucket: bucket.bucketName,
            key: cdk.Fn.select(0, code.objectKeys),
            versionId: cdk.Fn.select(0, code.objectVersionIds),
          },
        },
        runtimeConfig: { runtime: 'nodejs24.x' },
      },
      serviceConfig: {
        executionRoleArn: role.roleArn,
        timeoutSeconds: 60,
        maxConcurrencyPerEnvironment: 4,
        environmentVariables: {
          AWS_LAMBDA_NODEJS_ENTRYPOINT: 'index.mjs',
          APP_AWS_REGION: stack.region,
          CONFIG_PARAMETER: this.configParameterName,
          COGNITO_ISSUER: props.issuer,
          MCP_SCOPE: props.scope,
          KEY_SECRET_ARN: key.secretArn,
          TOKEN_TABLE: table.tableName,
        },
        telemetryConfig: { loggingConfig: { logGroup: logGroup.logGroupName } },
      },
    });
    revision.node.addDependency(
      bucket.policy!,
      role,
      logGroup,
      localLogGroup,
      code
    );
    this.endpoint = new lambda.CfnWebFunctionEndpoint(this, 'Endpoint', {
      functionName: fn.attrFunctionArn,
      endpointName: 'dev',
      endpointType: 'HomeRegion',
      authType: 'ApplicationManaged',
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
      scalingConfig: { maxEnvironments: 2 },
      throttleConfig: { rateLimit: 100 },
    });
    this.baseUrl = `https://${this.endpoint.attrDomainName}`;
    acknowledge(
      this,
      'CloudFormation-Validate::F3006',
      'AWS::Lambda::WebFunction* はCDK検証用schemaに未収録。CloudFormation公式のリソース型を使用する。'
    );
    new cdk.CfnOutput(stack, 'DcrProxyBaseUrl', { value: this.baseUrl });
    new cdk.CfnOutput(stack, 'DcrProxyUrl', { value: `${this.baseUrl}/mcp` });
    new cdk.CfnOutput(stack, 'DcrProxyLogGroup', {
      value: logGroup.logGroupName,
    });
  }
}
