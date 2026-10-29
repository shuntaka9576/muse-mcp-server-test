import * as cdk from 'aws-cdk-lib';
import { getConfig } from '../lib/config.js';
import { McpTestStack } from '../lib/mcp-test-stack.js';
import { applyNag } from '../lib/nag.js';

const app = new cdk.App();
const config = getConfig({
  stageName: app.node.tryGetContext('stageName'),
  region: app.node.tryGetContext('region'),
  additionalCallbackUrls: app.node.tryGetContext('additionalCallbackUrls'),
});

const stack = new McpTestStack(app, `${config.prefix}-test`, {
  config,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region },
  description: 'Muse meeting room booking: DSQL and Cognito AgentCore Gateway',
});
cdk.Tags.of(stack).add('Project', 'muse-mcp-server-test');
cdk.Tags.of(stack).add('Stage', config.stageName);
applyNag(app);
