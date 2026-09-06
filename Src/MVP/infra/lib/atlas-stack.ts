import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export interface AtlasStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  sgAtlas: ec2.ISecurityGroup;
}

// Project, cluster M10 e Private Endpoint Service Atlas sono gestiti a mano
// nella console Atlas (org di Alessandro): il team non ha una API key con
// permessi di scrittura sul progetto. Questo stack crea solo il lato AWS
// del PrivateLink, cioè l'Interface VPC Endpoint che punta al service name
// che Atlas genera quando il Private Endpoint viene creato in console.
//
// Handshake manuale (vedi RUNBOOK.md):
// 1. Alessandro crea il Private Endpoint su Atlas (regione AWS eu-south-1),
//    ottiene un service name (com.amazonaws.vpce...).
// 2. `cdk deploy CodeGuardian-Atlas --context atlasPrivateEndpointServiceName=<...>`
//    crea l'Interface VPC Endpoint qui sotto.
// 3. L'ID dell'endpoint (output AtlasPrivateEndpointId) va incollato in Atlas
//    per completare il collegamento e sbloccare la connection string.
export class AtlasStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AtlasStackProps) {
    super(scope, id, props);
    const { vpc, sgAtlas } = props;

    const serviceName = this.node.tryGetContext("atlasPrivateEndpointServiceName");
    if (!serviceName) {
      throw new Error(
        "Contesto 'atlasPrivateEndpointServiceName' non impostato: recuperare il service name del Private Endpoint da Atlas (creato a mano) e passarlo con --context (vedi RUNBOOK.md).",
      );
    }

    const awsPrivateEndpoint = new ec2.CfnVPCEndpoint(this, "AtlasAwsPrivateEndpoint", {
      serviceName,
      vpcId: vpc.vpcId,
      subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
      vpcEndpointType: "Interface",
      securityGroupIds: [sgAtlas.securityGroupId],
      privateDnsEnabled: false, // la risoluzione passa dalla connection string fornita da Atlas
    });

    new cdk.CfnOutput(this, "AtlasPrivateEndpointId", {
      value: awsPrivateEndpoint.ref,
      description:
        "Incollare in Atlas (Private Endpoint -> AWS) per completare il collegamento, poi recuperare la connection string per il secret codeguardian/mongo-uri",
    });
  }
}
