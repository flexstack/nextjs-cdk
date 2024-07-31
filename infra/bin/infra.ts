#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { HttpApi, VpcLink } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpServiceDiscoveryIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  AllowedMethods,
  CacheCookieBehavior,
  CachePolicy,
  Distribution,
  OriginProtocolPolicy,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import {
  GatewayVpcEndpointAwsService,
  IpAddresses,
  IpProtocol,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import {
  Cluster,
  Compatibility,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  LinuxParameters,
  OperatingSystemFamily,
  PropagatedTagSource,
  TaskDefinition,
} from "aws-cdk-lib/aws-ecs";
import { DnsRecordType, NamespaceType } from "aws-cdk-lib/aws-servicediscovery";

const projectName = process.env.PROJECT_NAME ?? "nextjs-cdk";
const environment = process.env.ENVIRONMENT ?? "prod";
const cpuArch =
  process.env.CPU_ARCH === "x86"
    ? CpuArchitecture.X86_64
    : CpuArchitecture.ARM64;
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new cdk.App({
  context: {
    ...env,
    environment,
  },
  defaultStackSynthesizer: new cdk.DefaultStackSynthesizer({
    qualifier: "nextjscdk",
    bucketPrefix: `${environment}/`,
  }),
});

const networkStack = new cdk.Stack(app, "Network", {
  stackName: `Network-${projectName}-${environment}`,
  env,
});

const vpc = new Vpc(networkStack, "Vpc", {
  maxAzs: 2,
  reservedAzs: 4, // reserve 2 extra AZs for future use
  ipAddresses: IpAddresses.cidr("10.0.0.0/16"),
  ipProtocol: IpProtocol.DUAL_STACK,
  enableDnsHostnames: true,
  enableDnsSupport: true,
  subnetConfiguration: [
    {
      cidrMask: 20,
      name: "Public",
      subnetType: SubnetType.PUBLIC,
      mapPublicIpOnLaunch: true,
    },
    {
      cidrMask: 20,
      name: "Private",
      subnetType: SubnetType.PRIVATE_WITH_EGRESS,
    },
    {
      cidrMask: 24,
      name: "Isolated",
      subnetType: SubnetType.PRIVATE_ISOLATED,
    },
  ],
  natGateways: 0,
  gatewayEndpoints: {
    S3: {
      service: GatewayVpcEndpointAwsService.S3,
    },
    DynamoDB: {
      service: GatewayVpcEndpointAwsService.DYNAMODB,
    },
  },
});

const cluster = new Cluster(networkStack, "Cluster", {
  vpc,
  clusterName: `${projectName}-${environment}`,
  enableFargateCapacityProviders: true,
});

cluster.addDefaultCloudMapNamespace({
  type: NamespaceType.DNS_PRIVATE,
  name: `${projectName}-${environment}.internal`,
  useForServiceConnect: true,
});
const privateDnsNamespace = cluster.defaultCloudMapNamespace;

const nextjsStack = new cdk.Stack(app, "NextJS", {
  stackName: `NextJS-${projectName}-${environment}`,
  env,
});

const taskDefinition = new TaskDefinition(nextjsStack, "TaskDefinition", {
  family: `${projectName}-nextjs-${environment}`,
  cpu: "256",
  memoryMiB: "512",
  runtimePlatform: {
    operatingSystemFamily: OperatingSystemFamily.LINUX,
    cpuArchitecture: cpuArch,
  },
  compatibility: Compatibility.FARGATE,
});

const platform =
  cpuArch === CpuArchitecture.ARM64
    ? Platform.LINUX_ARM64
    : Platform.LINUX_AMD64;

const container = taskDefinition.addContainer("NextJSContainer", {
  image: ContainerImage.fromAsset("../", {
    exclude: [".git", ".readme", "node_modules", "infra"],
    platform: platform,
    buildArgs: {
      TARGETOS: "linux",
      TARGETARCH: platform == Platform.LINUX_ARM64 ? "arm64" : "amd64",
    },
  }),
  linuxParameters: new LinuxParameters(nextjsStack, "LinuxParameters", {
    initProcessEnabled: true,
  }),
});

container.addPortMappings({
  name: "http",
  containerPort: 3000,
});

const serviceSg = new SecurityGroup(nextjsStack, "ServiceSecurityGroup", {
  vpc,
  allowAllIpv6Outbound: true,
  allowAllOutbound: true,
});

const fargateService = new FargateService(nextjsStack, "FargateService", {
  cluster,
  taskDefinition,
  securityGroups: [serviceSg],
  desiredCount: 1,
  assignPublicIp: true, // Selects public subnets by default
  minHealthyPercent: 50,
  maxHealthyPercent: 200,
  circuitBreaker: {
    enable: true,
    rollback: true,
  },
  propagateTags: PropagatedTagSource.SERVICE,
  capacityProviderStrategies: [
    {
      capacityProvider: "FARGATE",
      weight: 1,
    },
  ],
});

const scaling = fargateService.autoScaleTaskCount({
  minCapacity: 1,
  maxCapacity: 2,
});

scaling.scaleOnCpuUtilization("CpuScaling", {
  targetUtilizationPercent: 75,
  scaleInCooldown: cdk.Duration.seconds(90),
  scaleOutCooldown: cdk.Duration.seconds(120),
});

const cloudMap = fargateService.enableCloudMap({
  cloudMapNamespace: privateDnsNamespace,
  name: "dns.nextjs",
  dnsTtl: cdk.Duration.seconds(60),
  dnsRecordType: DnsRecordType.SRV,
});

const apiGw = new HttpApi(nextjsStack, "HttpApi", {
  apiName: `${projectName}-${environment}`,
  disableExecuteApiEndpoint: false, // Set to true if using a custom domain
});

const vpcLinkSg = new SecurityGroup(nextjsStack, "VpcLinkSecurityGroup", {
  vpc,
  allowAllIpv6Outbound: true,
  allowAllOutbound: true,
});
fargateService.connections.allowFrom(
  vpcLinkSg,
  Port.tcp(3000),
  "Allow traffic on container port from the VPC Link"
);

const vpcLink = new VpcLink(nextjsStack, "VpcLink", {
  vpc,
  vpcLinkName: `${projectName}-${environment}`,
  subnets: vpc.selectSubnets({
    subnetType: SubnetType.PUBLIC,
  }),
  securityGroups: [vpcLinkSg],
});

apiGw.addRoutes({
  path: "/{proxy+}",
  integration: new HttpServiceDiscoveryIntegration(
    "ServiceDiscovery",
    cloudMap,
    {
      vpcLink,
    }
  ),
});

const distribution = new Distribution(nextjsStack, "CDN", {
  defaultBehavior: {
    origin: new HttpOrigin(cdk.Fn.select(2, cdk.Fn.split("/", apiGw.url!)), {
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
      originPath: "/",
      protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
    }),
    allowedMethods: AllowedMethods.ALLOW_ALL,
    cachedMethods: AllowedMethods.ALLOW_GET_HEAD,
    viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    compress: true,
    cachePolicy: new CachePolicy(nextjsStack, "CachePolicy", {
      cookieBehavior: CacheCookieBehavior.none(),
      headerBehavior: CacheCookieBehavior.none(),
      queryStringBehavior: CacheCookieBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0), // Disable caching by default, rely on cache control headers
    }),
  },
  priceClass: PriceClass.PRICE_CLASS_100, // US, Canada, Europe - cheapest option
});
