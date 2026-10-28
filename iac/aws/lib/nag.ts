import { Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { IConstruct } from 'constructs';

export function applyNag(scope: IConstruct): void {
  Validations.of(scope).addPlugins(
    new AwsSolutionsChecks(scope, { verbose: true })
  );
}

export function acknowledge(
  scope: IConstruct,
  id: string,
  reason: string
): void {
  // shuntaka-dev と同様、ARN内の :: を含むfindingにも対応する。
  scope.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
    [id]: reason,
  });
}
