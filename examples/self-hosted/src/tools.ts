import { z } from "zod";
import { forPrincipal, toolError, toolOk, type ContentPart, type McpPrincipal, type ToolResult } from "@klakix/mcp-server";
import { InsufficientCreditsError, type GenerationBackend, type VideoJob } from "./backend.ts";

export const SCOPE_READ = "mcp:read";
export const SCOPE_GENERATE = "mcp:generate";

/** What `authenticate` returns for a request and what every tool receives as `ctx.principal`. */
export interface DemoPrincipal extends McpPrincipal {
  userId: string;
  scopes: ReadonlySet<string>;
  /** How the caller signed in. */
  via: "oauth" | "api_key";
  clientId?: string;
}

const { defineTool, definePrompt, defineResource } = forPrincipal<DemoPrincipal>();

const aspectRatioField = z.enum(["1:1", "16:9", "9:16"]).default("1:1").describe("Shape of the result: 1:1, 16:9 or 9:16.");
const promptField = z.string().trim().min(3).max(1000).describe("What to generate, in plain language.");

const WAIT_STEP_MS = 250;
const MAX_WAIT_SECONDS = 30;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function jobData(job: VideoJob): Record<string, unknown> {
  return {
    generation_id: job.id,
    status: job.status,
    progress: job.progress,
    prompt: job.prompt,
    duration_seconds: job.durationSeconds,
    aspect_ratio: job.aspectRatio,
    credits_used: job.creditsUsed,
    ...(job.status === "queued" || job.status === "processing" ? { estimated_seconds: job.estimatedSeconds } : {}),
    ...(job.videoUrl ? { video_url: job.videoUrl } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function jobResult(job: VideoJob): ToolResult {
  const summary =
    job.status === "completed"
      ? `Generation ${job.id} is completed.`
      : job.status === "failed"
        ? `Generation ${job.id} failed.`
        : `Generation ${job.id} is ${job.status} (${job.progress}%). Call get_generation again to check.`;
  const links: ContentPart[] = [];
  if (job.status === "completed" && job.videoUrl) {
    links.push({ type: "resource_link", uri: job.videoUrl, name: `${job.id}.mp4`, mimeType: "video/mp4", description: "Generated video" });
    if (job.posterUrl) links.push({ type: "resource_link", uri: job.posterUrl, name: `${job.id}-poster.svg`, mimeType: "image/svg+xml", description: "Poster image" });
  }
  return toolOk(summary, jobData(job), links, { generationId: job.id, status: job.status });
}

function insufficientCredits(error: InsufficientCreditsError): ToolResult {
  return toolError("insufficient_credits", error.message, { needed: error.needed, available: error.available, hint: "Use get_account to check the balance." });
}

export function createTools(backend: GenerationBackend) {
  const generateImage = defineTool({
    name: "generate_image",
    title: "Generate image",
    description: "Generate an image from a text prompt. Returns the image inline and as a link. The demo backend draws a placeholder from the prompt.",
    inputSchema: z.object({ prompt: promptField, aspect_ratio: aspectRatioField }),
    scope: SCOPE_GENERATE,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async handler({ prompt, aspect_ratio }, ctx) {
      try {
        const image = await backend.generateImage(ctx.principal.userId, { prompt, aspectRatio: aspect_ratio });
        return toolOk(
          "Generated 1 image.",
          { prompt, aspect_ratio, credits_used: image.creditsUsed, image_url: image.url },
          [
            { type: "image", data: image.data, mimeType: image.mimeType },
            { type: "resource_link", uri: image.url, name: "image.svg", mimeType: image.mimeType, description: "Generated image" },
          ],
          { creditsUsed: image.creditsUsed },
        );
      } catch (error) {
        if (error instanceof InsufficientCreditsError) return insufficientCredits(error);
        throw error;
      }
    },
  });

  const generateVideo = defineTool({
    name: "generate_video",
    title: "Generate video",
    description:
      "Start a video generation. Videos take time: this returns a generation_id right away with status queued. Call get_generation with that id (wait_seconds lets the call wait) until the status is completed.",
    inputSchema: z.object({
      prompt: promptField,
      duration_seconds: z.number().int().min(3).max(10).default(5).describe("Length of the clip in seconds, 3 to 10."),
      aspect_ratio: aspectRatioField,
    }),
    scope: SCOPE_GENERATE,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async handler({ prompt, duration_seconds, aspect_ratio }, ctx) {
      try {
        const job = await backend.startVideo(ctx.principal.userId, { prompt, durationSeconds: duration_seconds, aspectRatio: aspect_ratio });
        return toolOk(`Queued generation ${job.id}. Call get_generation with this id to follow it.`, jobData(job), [], { generationId: job.id, creditsUsed: job.creditsUsed });
      } catch (error) {
        if (error instanceof InsufficientCreditsError) return insufficientCredits(error);
        throw error;
      }
    },
  });

  const getGeneration = defineTool({
    name: "get_generation",
    title: "Get generation",
    description: "Check a video generation by id. With wait_seconds the call waits for the result, up to that many seconds, which saves polling.",
    inputSchema: z.object({
      generation_id: z.string().min(1).max(64).describe("The id returned by generate_video."),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0).describe("Seconds to wait for completion, 0 to 30."),
    }),
    scope: SCOPE_READ,
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler({ generation_id, wait_seconds }, ctx) {
      const userId = ctx.principal.userId;
      let job = await backend.getVideo(userId, generation_id);
      if (!job) return toolError("not_found", `No generation with id ${generation_id}.`, { hint: "Use the generation_id returned by generate_video." });
      const deadline = Date.now() + wait_seconds * 1000;
      while ((job.status === "queued" || job.status === "processing") && Date.now() < deadline && !ctx.request.signal.aborted) {
        await sleep(Math.min(WAIT_STEP_MS, deadline - Date.now()), ctx.request.signal);
        job = (await backend.getVideo(userId, generation_id)) ?? job;
      }
      return jobResult(job);
    },
  });

  const getAccount = defineTool({
    name: "get_account",
    title: "Get account",
    description: "Show the signed-in account: credit balance, number of generations and the permissions of this connection.",
    inputSchema: z.object({}),
    scope: SCOPE_READ,
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(_input, ctx) {
      const account = await backend.getAccount(ctx.principal.userId);
      return toolOk(`Account ${ctx.principal.userId} has ${account.credits} credits.`, {
        user_id: ctx.principal.userId,
        plan: "demo",
        credits: account.credits,
        generations: account.generations,
        signed_in_with: ctx.principal.via,
        scopes: [...ctx.principal.scopes].sort(),
      });
    },
  });

  return [generateImage, generateVideo, getGeneration, getAccount];
}

export const productAdPrompt = definePrompt({
  name: "product_ad",
  title: "Product ad",
  description: "Plan and generate a short product ad: one hero image and one video.",
  arguments: [
    { name: "product", description: "What is being advertised", required: true },
    { name: "audience", description: "Who the ad is for" },
    { name: "tone", description: "For example playful, premium or direct" },
  ],
  render: ({ product, audience, tone }) =>
    [
      `Create a short ad for: ${product}.`,
      ...(audience ? [`Audience: ${audience}.`] : []),
      ...(tone ? [`Tone: ${tone}.`] : []),
      "",
      "1. Write a one-sentence concept and a hero image prompt (see the prompting-guide resource).",
      "2. Call generate_image with that prompt.",
      "3. Call generate_video with a prompt that moves the same scene, then call get_generation with wait_seconds until it is completed.",
      "4. Reply with the links and the concept.",
    ].join("\n"),
});

export const promptingGuide = defineResource({
  uri: "docs://prompting-guide",
  name: "prompting-guide",
  title: "Prompting guide",
  description: "Short guidance for writing image and video prompts.",
  mimeType: "text/markdown",
  read: () =>
    [
      "# Prompting guide",
      "",
      "- Name the subject first, then the setting, then the light. One sentence is enough.",
      "- For video, describe one motion, for example a slow push-in or a pan to the right. Several moves in one clip rarely work.",
      "- Pick the aspect ratio for where the result will be shown: 9:16 for vertical feeds, 16:9 for web and TV.",
      "- Do not ask for text inside the image; add captions afterwards.",
      "- Start with 3 to 5 second clips and extend only what works.",
      "",
      "This guide ships with the self-hosted example. Replace it with your own.",
    ].join("\n"),
});
