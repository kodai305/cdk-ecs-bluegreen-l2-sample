import { Duration, RemovalPolicy, Stack, StackProps, Token } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
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
    const vpc = new ec2.Vpc(this, 'VPCBG', {
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
    // 証明書関連はドメインに依存するので省略
    securityGroupELB.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic from the world');
    securityGroupELB.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9000), 'Allow HTTP traffic from the world for Green');

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

    // Blue リスナー
    const blueListener = alb.addListener('BlueListener', {
      port: 80,
      open: true,
    });

    // Blue Target Group
    const blueTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BlueTargetGroup', {
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
    blueListener.addTargetGroups('BlueTargetGroup', {
      targetGroups: [blueTargetGroup],
    });

    // Green リスナー
    const greenListener = alb.addListener('GreenListener', {
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 9000,
      open: true,
    })    

    // Green Target Group
    const greenTargetGroup = new elbv2.ApplicationTargetGroup(this, 'GreenTargetGroup', {
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
    greenListener.addTargetGroups('GreenTargetGroup', {
      targetGroups: [greenTargetGroup]
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
    // B/Gアップデート: https://zenn.dev/shshimamo/articles/2c04cce1dc5502
    const service = new ecs.FargateService(this, 'Service', {
      serviceName: 'ecs-bluegreen-l2-service',
      cluster,
      taskDefinition: fargateTaskDefinition,
      securityGroups: [securityGroupAPP],
      enableExecuteCommand: true,
      desiredCount: 3,
      vpcSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }),
      deploymentController: { type: ecs.DeploymentControllerType.CODE_DEPLOY }, 
    });
    service.attachToApplicationTargetGroup(blueTargetGroup);

    // CodeDeploy の ECS アプリケーションを作成
    const ecsApplication = new codedeploy.EcsApplication(this, 'EcsBGApplication', {});

    // デプロイグループ
    const ecsDeploymentGroup = new codedeploy.EcsDeploymentGroup(this, 'EcsDeploymentGroup', {
      blueGreenDeploymentConfig: {  // ターゲットグループやリスナー
        blueTargetGroup: blueTargetGroup,
        greenTargetGroup: greenTargetGroup,
        listener: blueListener,
        testListener: greenListener,
        deploymentApprovalWaitTime: cdk.Duration.minutes(10), // 待ち時間
        terminationWaitTime: cdk.Duration.minutes(10),        // 切り替え後に元のVersionを残しておく時間
      },
      // ロールバックの設定
      autoRollback: {  
          failedDeployment: true
      },
      service: service,  // ECSサービス
      application: ecsApplication,  // ECSアプリケーション
      deploymentConfig: codedeploy.EcsDeploymentConfig.ALL_AT_ONCE, // デプロイの方式
    });
  }
}

/**
 * sample of appspec.yaml:

version: 0.0
Resources:
  - TargetService:
      Type: AWS::ECS::Service
      Properties:
        TaskDefinition: "arn:aws:ecs:aws-region-id:aws-account-id:task-definition/ecs-demo-task-definition:revision-number"
        LoadBalancerInfo:
          ContainerName: "your-container-name"
          ContainerPort: your-container-port
 */