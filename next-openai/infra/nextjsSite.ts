// Copyright 2023, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as aws from "@pulumi/aws"; 
import * as pulumi from "@pulumi/pulumi";

import * as childprocess from "child_process";
import * as crypto from "crypto";
import * as glob from "glob";
import * as mime from "mime";
import * as path from "path";

export interface NexJsSiteArgs {
    /**
     * The command to run to build the Next.js site.
     * Defaults to `npm install && npx --yes open-next@2.0.5 build`. Set to empty string to
     * skip building the site (and you will then need to build it manually with open-next before
     * deploying).
     */
    build?: string
    /**
     * The path to the Next.js site to deploy. Defaults to the current working directory.
     */
    path?: string;
    /**
     * The key-value pairs of environment variables to pass into the functions that serve the site.
     * Defaults to {}.
     */
    environment?: Record<string, pulumi.Input<string>>;
}

export class NextJsSite extends pulumi.ComponentResource {
    build: string;
    path: string;
    environment: Record<string, pulumi.Input<string>>;
    domainName: pulumi.Output<string>;
    url: pulumi.Output<string>;
    public constructor(name: string, args: NexJsSiteArgs, opts?: pulumi.ComponentResourceOptions) {
        super("cloud:index:NextJsSite", name, {}, opts);

        this.path = args.path ?? ".";
        this.environment = args.environment ?? {};
        this.build = args.build ?? "npm install && npx --yes open-next@2.0.5 build";

        if (this.build !== "") {
            try {
                // TODO: Can we avoid running this on every preview+update?
                // Perhaps we can do a rough hash of the target deployment path and only
                // rebuild if there are changes?
                childprocess.execSync(this.build, {
                    stdio: "inherit",
                    cwd: this.path,
                });
            } catch (error) {
                pulumi.log.warn("Could not build Next.js site.");
            }
        }

        const bucket = new aws.s3.BucketV2(`${name}-bucket`, {
            forceDestroy: true,
        }, { parent: this });

        const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(`${name}-bucket-public-access`, {
            bucket: bucket.id,
            blockPublicAcls: true,
            blockPublicPolicy: true,
            ignorePublicAcls: true,
            restrictPublicBuckets: true,
        }, { parent: this });

        const files = glob.sync("**", {
            cwd: path.resolve(this.path, ".open-next/assets"),
            dot: true,
            nodir: true,
            follow: true,
        });
        for (const file of files) {
            const cacheControlVersioned = "public,max-age=31536000,immutable";
            const cacheControlUnversioned = "public,max-age=0,s-maxage=31536000,must-revalidate";
            const hash = computeMd5Hash(file);
            const key = path.join("_assets", file);
            const object = new aws.s3.BucketObject(`${name}-asset-${hash}`, {
                bucket: bucket.id,
                key: key,
                source: new pulumi.asset.FileAsset(path.resolve(this.path, ".open-next/assets", file)),
                cacheControl: file.startsWith("_next/") ? cacheControlVersioned : cacheControlUnversioned,
                contentType: mime.getType(file) || undefined,
                etag: hash,
            }, { parent: this });
        }

        const cachefiles = glob.sync("**", {
            cwd: path.resolve(this.path, ".open-next/cache"),
            dot: true,
            nodir: true,
            follow: true,
        });
        for (const file of cachefiles) {
            const hash = computeMd5Hash(file);
            const key = path.join("_cache", file);
            const object = new aws.s3.BucketObject(`${name}-cache-${hash}`, {
                bucket: bucket.id,
                key: key,
                source: new pulumi.asset.FileAsset(path.resolve(this.path, ".open-next/cache", file)),
                contentType: mime.getType(file) || undefined,
                etag: hash,
            }, { parent: this });
        }

        const cloudfrontFunction = new aws.cloudfront.Function(`${name}-cloudfront-function`, {
            code: `function handler(event) { var request = event.request; request.headers["x-forwarded-host"] = request.headers.host; return request; }`,
            runtime: "cloudfront-js-1.0",
            publish: true,
        }, { parent: this });

        const cachePolicy = new aws.cloudfront.CachePolicy(`${name}-cachepolicy`, {
            comment: `Pulumi Cloud server reponse cache policy`,
            defaultTtl: 0,
            maxTtl: 31536000,
            minTtl: 0,
            parametersInCacheKeyAndForwardedToOrigin: {
                cookiesConfig: {
                    cookieBehavior: "none",
                },
                enableAcceptEncodingBrotli: true,
                enableAcceptEncodingGzip: true,
                headersConfig: {
                    headerBehavior: "whitelist",
                    headers: {
                        items: [
                            "accept",
                            "rsc",
                            "next-router-prefetch",
                            "next-router-state-tree",
                            "next-url",
                        ],
                    },
                },
                queryStringsConfig: {
                    queryStringBehavior: "all",
                },
            },
        }, { parent: this });

        function makeBehaviour(args: { pathPattern: string, origin: string, functionArn?: pulumi.Input<string>, readOnly?: boolean, cachePolicyId?: string }): aws.types.input.cloudfront.DistributionOrderedCacheBehavior {
            return {
                allowedMethods: [
                    "GET",
                    "HEAD",
                    "OPTIONS",
                    ...(args.readOnly ? [] : [
                        "PUT",
                        "PATCH",
                        "POST",
                        "DELETE",
                    ]),
                ],
                cachePolicyId: args.cachePolicyId ?? cachePolicy.id,
                cachedMethods: [
                    "GET",
                    "HEAD",
                    "OPTIONS",
                ],
                compress: true,
                functionAssociations: args.functionArn ? [{
                    eventType: "viewer-request",
                    functionArn: args.functionArn,
                }] : undefined,
                pathPattern: args.pathPattern,
                targetOriginId: args.origin,
                viewerProtocolPolicy: "redirect-to-https",
            };
        }

        const serverOrigin = "server";
        const imageOrigin = "image";
        const staticOrigin = "static";

        const apiBehaviour = makeBehaviour({
            pathPattern: "api/*",
            origin: serverOrigin,
            functionArn: cloudfrontFunction.arn,
        });
        const dataBehaviour = makeBehaviour({
            pathPattern: "_next/data/*",
            origin: serverOrigin,
            functionArn: cloudfrontFunction.arn,
        });
        const imagesBehaviour = makeBehaviour({
            pathPattern: "_next/image*",
            origin: imageOrigin,
        });
        const buildIdBehaviour = makeBehaviour({
            pathPattern: "BUILD_ID",
            origin: staticOrigin,
            readOnly: true,
            cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
        });
        const nextBehaviour = makeBehaviour({
            pathPattern: "_next/*",
            origin: staticOrigin,
            readOnly: true,
            cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
        });
        const nextSvgBehaviour = makeBehaviour({
            pathPattern: "next.svg",
            origin: staticOrigin,
            readOnly: true,
            cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
        });
        const vercelSvgBehaviour = makeBehaviour({
            pathPattern: "vercel.svg",
            origin: staticOrigin,
            readOnly: true,
            cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
        });

        const queue = new aws.sqs.Queue(`${name}-queue`, {
            fifoQueue: true,
            receiveWaitTimeSeconds: 20,
        }, { parent: this });

        const serverFunctionRole = new aws.iam.Role(`${name}-server-function-role`, {
            assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
            managedPolicyArns: [aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole],
        }, { parent: this });

        const serverFunctionPolicy = new aws.iam.RolePolicy(`${name}-server-function-policy`, {
            role: serverFunctionRole,
            policy: {
                "Statement": [
                    {
                        "Action": [
                            "s3:GetObject*",
                            "s3:GetBucket*",
                            "s3:List*",
                            "s3:DeleteObject*",
                            "s3:PutObject",
                            "s3:PutObjectLegalHold",
                            "s3:PutObjectRetention",
                            "s3:PutObjectTagging",
                            "s3:PutObjectVersionTagging",
                            "s3:Abort*",
                        ],
                        "Effect": "Allow",
                        "Resource": [
                            bucket.arn,
                            pulumi.interpolate`${bucket.arn}/*`,
                        ],
                    },
                    {
                        "Action": [
                            "sqs:SendMessage",
                            "sqs:GetQueueAttributes",
                            "sqs:GetQueueUrl",
                        ],
                        "Effect": "Allow",
                        "Resource": queue.arn,
                    },
                ],
                "Version": "2012-10-17",
            },
        }, { parent: this });

        const serverFunction = new aws.lambda.Function(`${name}-server-function`, {
            code: new pulumi.asset.FileArchive(path.join(this.path, "./.open-next/server-function")),
            role: serverFunctionRole.arn,
            architectures: ["arm64"],
            handler: "index.handler",
            memorySize: 1024,
            runtime: "nodejs18.x",
            timeout: 10,
            environment: {
                variables: {
                    "CACHE_BUCKET_NAME": bucket.bucket,
                    "CACHE_BUCKET_KEY_PREFIX": "_cache",
                    "CACHE_BUCKET_REGION": "us-west-2",
                    "REVALIDATION_QUEUE_URL": queue.id,
                    "REVALIDATION_QUEUE_REGION": "us-west-2",
                    ...this.environment,
                },
            },
        }, { parent: this, dependsOn: [serverFunctionPolicy] });

        const imageFunctionRole = new aws.iam.Role(`${name}-image-function-role`, {
            assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
            managedPolicyArns: [aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole],
        }, { parent: this });

        const imageFunctionPolicy = new aws.iam.RolePolicy(`${name}-image-function-policy`, {
            role: imageFunctionRole,
            policy: {
                "Statement": [
                    {
                        "Action": [
                            "s3:GetObject",
                        ],
                        "Effect": "Allow",
                        "Resource": pulumi.interpolate`${bucket.arn}/*`,
                    },
                ],
                "Version": "2012-10-17",
            },
        }, { parent: this });

        const imageFunction = new aws.lambda.Function(`${name}-image-function`, {
            code: new pulumi.asset.FileArchive(path.join(this.path, "./.open-next/image-optimization-function")),
            role: imageFunctionRole.arn,
            architectures: ["arm64"],
            handler: "index.handler",
            memorySize: 1536,
            runtime: "nodejs18.x",
            timeout: 25,
            environment: {
                variables: {
                    "BUCKET_NAME": bucket.arn,
                    "BUCKET_KEY_PREFIX": "_assets",
                },
            },
        }, { parent: this, dependsOn: [imageFunctionPolicy] });

        const revalidationFunctionRole = new aws.iam.Role(`${name}-revalidation-function-role`, {
            assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
            managedPolicyArns: [aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole],
        }, { parent: this });

        const revalidationFunctionPolicy = new aws.iam.RolePolicy(`${name}-revalidation-function-policy`, {
            role: revalidationFunctionRole,
            policy: {
                "Statement": [
                    {
                        "Action": [
                            "sqs:ReceiveMessage",
                            "sqs:ChangeMessageVisibility",
                            "sqs:GetQueueUrl",
                            "sqs:DeleteMessage",
                            "sqs:GetQueueAttributes",
                        ],
                        "Effect": "Allow",
                        "Resource": queue.arn,
                    },
                ],
                "Version": "2012-10-17",
            },
        }, { parent: this });

        const revalidationFunction = new aws.lambda.Function(`${name}-revalidation-function`, {
            code: new pulumi.asset.FileArchive(path.join(this.path, "./.open-next/revalidation-function")),
            role: revalidationFunctionRole.arn,
            handler: "index.handler",
            runtime: "nodejs18.x",
            timeout: 30,
            environment: {
                variables: {
                    "BUCKET_NAME": bucket.arn,
                    "BUCKET_KEY_PREFIX": "_assets",
                },
            },
        }, { parent: this, dependsOn: [revalidationFunctionPolicy] });

        const revalidationFunctionEventSourceMapping = new aws.lambda.EventSourceMapping(`${name}-revalidation-function-event-source-mapping`, {
            functionName: revalidationFunction.id,
            batchSize: 5,
            eventSourceArn: queue.arn,
        }, { parent: this });

        const serverFunctionUrl = new aws.lambda.FunctionUrl(`${name}-server-url`, {
            functionName: serverFunction.arn,
            authorizationType: "NONE",
        }, { parent: this });

        const serverFunctionInvokePermission = new aws.lambda.Permission(`${name}-server-function-invoke-permission`, {
            action: "lambda:InvokeFunctionUrl",
            function: serverFunction.arn,
            principal: "*",
            functionUrlAuthType: "NONE",
        }, { parent: this });

        const imageFunctionUrl = new aws.lambda.FunctionUrl(`${name}-image-url`, {
            functionName: imageFunction.arn,
            authorizationType: "NONE",
        }, { parent: this });

        const imageFunctionInvokePermission = new aws.lambda.Permission(`${name}-image-function-invoke-permission`, {
            action: "lambda:InvokeFunctionUrl",
            function: imageFunction.arn,
            principal: "*",
            functionUrlAuthType: "NONE",
        }, { parent: this });

        const originAccessIdentity = new aws.cloudfront.OriginAccessIdentity(`${name}-origin-identity`, {
        }, { parent: this });

        const { pathPattern, ...defaultBehavior } = apiBehaviour;

        const distribution = new aws.cloudfront.Distribution(`${name}-distribution`, {
            aliases: [],
            orderedCacheBehaviors: [
                apiBehaviour,
                dataBehaviour,
                imagesBehaviour,
                buildIdBehaviour,
                nextBehaviour,
                nextSvgBehaviour,
                vercelSvgBehaviour,
            ],
            defaultCacheBehavior: defaultBehavior,
            enabled: true,
            httpVersion: "http2",
            isIpv6Enabled: true,
            restrictions: {
                geoRestriction: {
                    restrictionType: "none",
                },
            },
            viewerCertificate: {
                cloudfrontDefaultCertificate: true,
            },
            origins: [
                {
                    originId: serverOrigin,
                    domainName: serverFunctionUrl.functionUrl.apply(url => url.split("//")[1].split("/")[0]),
                    customOriginConfig: {
                        httpPort: 80,
                        httpsPort: 443,
                        originProtocolPolicy: "https-only",
                        originReadTimeout: 10,
                        originSslProtocols: ["TLSv1.2"],
                    },
                },
                {
                    originId: imageOrigin,
                    domainName: imageFunctionUrl.functionUrl.apply(url => url.split("//")[1].split("/")[0]),
                    customOriginConfig: {
                        httpPort: 80,
                        httpsPort: 443,
                        originProtocolPolicy: "https-only",
                        originSslProtocols: ["TLSv1.2"],
                    },
                },
                {
                    originId: staticOrigin,
                    domainName: bucket.bucketRegionalDomainName,
                    originPath: "/_assets",
                    s3OriginConfig: {
                        originAccessIdentity: originAccessIdentity.cloudfrontAccessIdentityPath,
                    },
                },
            ],
        }, { parent: this });

        const policy = new aws.s3.BucketPolicy(`${name}-bucket-policy`, {
            bucket: bucket.id,
            policy: {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Action": "s3:GetObject",
                        "Effect": "Allow",
                        "Principal": <any>{
                            "CanonicalUser": originAccessIdentity.s3CanonicalUserId,
                        },
                        "Resource": pulumi.interpolate`${bucket.arn}/*`,
                    },
                ],
            },
        }, { parent: this });

        this.domainName = distribution.domainName;
        this.url = pulumi.interpolate`https://${distribution.domainName}`;
    }
}

function computeMd5Hash(s: string) {
    return crypto.createHash("md5").update(s).digest("hex");
}
