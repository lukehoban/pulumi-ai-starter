import * as pulumi from "@pulumi/pulumi";
import { NextJsSite } from "./nextjsSite";

const config = new pulumi.Config();
const openAIKey = config.requireSecret("openAIKey");

const aiSite = new NextJsSite("next-openai", {
    path: "..",
    environment: {
        OPENAI_API_KEY: openAIKey,
    },
}, { aliases: [{ name: "myaisite" }] });

export const url = aiSite.url;