import { Duration, RemovalPolicy, Stack, StackProps, Token } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { aws_elasticloadbalancingv2 as elbv2, } from 'aws-cdk-lib';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecrdeploy from 'cdk-ecr-deployment';
import { Construct } from 'constructs';

const generateRandomString = (charCount = 7): string => {
  const str = Math.random().toString(36).substring(2).slice(-charCount)
  return str.length < charCount ? str + 'a'.repeat(charCount - str.length) : str
};
export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    /**
     * ネットワーク関連
     */
    // create a VPC
    const vpc = new ec2.Vpc(this, 'VPC', {
      ipAddresses: ec2.IpAddresses.cidr('192.168.0.0/16'),
      maxAzs: 3,
      subnetConfiguration: [
        {
          // PublicSubnet
          cidrMask: 24,
          name: 'ingress',
          subnetType: ec2.SubnetType.PUBLIC,
        },        
        {
          // PrivateSubnet
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // ECR PullするためのVPCエンドポイント
    // 不要なものがあるかもしれない
    vpc.addInterfaceEndpoint("ecr-endpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR
    });
    vpc.addInterfaceEndpoint("ecr-dkr-endpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER
    });    
    vpc.addGatewayEndpoint("s3-gateway-endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3
    });
    vpc.addInterfaceEndpoint('cloud-watch-logs', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS
    });    

    // LoadBarancer用のセキュリティグループ
    const securityGroupELB = new ec2.SecurityGroup(this, 'SecurityGroupELB', {
      vpc,
      description: 'Security group ELB',
      securityGroupName: 'SGELB',
    });
    securityGroupELB.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic from the world'); // 必須？？

    // ECSで動作するアプリ用のセキュリティグループ
    const securityGroupAPP = new ec2.SecurityGroup(this, 'SecurityGroupAPP', {
      vpc,
      description: 'Security group APP',
      securityGroupName: 'SGAPP',
    })
    securityGroupAPP.addIngressRule(securityGroupELB, ec2.Port.tcp(80), 'Allow HTTP traffic from the ELB');

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      loadBalancerName: 'sample-cdk-bg-alb',
    })

    const listener = alb.addListener('Listener', {
      port: 80,
      open: true,
    });

    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        interval: Duration.seconds(60),
        healthyHttpCodes: '200'
      },
    });

    listener.addTargetGroups('TargetGroup', {
      targetGroups: [targetGroup],
    });

    /**
     * ECR関連
     */
    // リポジトリの作成
    const repo = new ecr.Repository(this, "cdk-ecs-bluegreen-l2-repo", {
      repositoryName: 'cdk-ecs-bluegreen-l2-sample-repo',
      removalPolicy: RemovalPolicy.DESTROY
    });

    // tag
    const tag = generateRandomString();

    // ビルド to CDKデフォルトリポジトリ
    const image = new DockerImageAsset(this, 'CDKDockerImage', {
      directory: '../app',
      platform: Platform.LINUX_ARM64,
    });
    // ビルドしたイメージをコピー to マイリポジトリ(SAMPLEなのでlatestタグ)
    new ecrdeploy.ECRDeployment(this, 'DeployDockerImage', {
      src: new ecrdeploy.DockerImageName(image.imageUri),
      dest: new ecrdeploy.DockerImageName(repo.repositoryUri + ':' + tag),
    });

    /**
     * ECS関連
     */

    // ECS クラスタの作成    
    const cluster = new ecs.Cluster(this, 'ECSCluster', {
      vpc: vpc,
      clusterName: `SAMPLE-ECSCluster`,
      containerInsights: true,
    });

    // タスク定義
    const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'SampleTaskDef', {
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },      
      ephemeralStorageGiB: 0,
      memoryLimitMiB: 1024 * 2,
      cpu: 1024 * 1,
    });
    // 自動で作られるTaskExecutionRoleでは、ECRからPullできなかったので、
    // AmazonECSTaskExecutionRolePolicyを適用
    fargateTaskDefinition.addToExecutionRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "logs:CreateLogStream",
          "logs:PutLogEvents"          
        ],
        resources: ['*']
      })
    );    
    fargateTaskDefinition.addContainer('SampleECS', {
      containerName: 'ecs-bluegreen-l2-container',
      image: ecs.ContainerImage.fromEcrRepository(repo, tag), // タグの指定がここでできる
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ecs-bluegreen-l2',
      }),
      portMappings: [{
        protocol: ecs.Protocol.TCP,
        containerPort: 80,
        hostPort: 80,
      }],      
    });

    // サービス
    // ローリングアップデート: https://speakerdeck.com/tomoki10/ideal-and-reality-when-implementing-cicd-for-ecs-on-fargate-with-aws-cdk?slide=41
    const service = new ecs.FargateService(this, 'Service', {
      serviceName: 'ecs-bluegreen-l2-service',
      cluster,
      taskDefinition: fargateTaskDefinition,
      securityGroups: [securityGroupAPP],
      enableExecuteCommand: true,
      desiredCount: 3,
      vpcSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }),
      maxHealthyPercent: 200, // https://stackoverflow.com/questions/40731143/what-is-the-minimum-healthy-percent-and-maximum-percent-in-amazon-ecs
      minHealthyPercent: 50,
      deploymentController: { type: ecs.DeploymentControllerType.ECS }, 
      circuitBreaker: { rollback: true }
    });
    service.attachToApplicationTargetGroup(targetGroup);
  }
}
