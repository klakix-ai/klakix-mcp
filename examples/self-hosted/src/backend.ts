import { randomBytes } from "node:crypto";
import { renderImageSvg, type AspectRatio } from "./art.ts";

/**
 * The generation backend is the seam between this example and a real service.
 * The tools in `tools.ts` only talk to this interface. To generate real media,
 * implement it with fal, Replicate, your own model server or anything else and
 * pass the instance to `createApp({ backend })`.
 */
export interface GenerationBackend {
  generateImage(userId: string, input: { prompt: string; aspectRatio: AspectRatio }): Promise<ImageResult>;
  startVideo(userId: string, input: { prompt: string; durationSeconds: number; aspectRatio: AspectRatio }): Promise<VideoJob>;
  getVideo(userId: string, id: string): Promise<VideoJob | null>;
  getAccount(userId: string): Promise<{ credits: number; generations: number }>;
}

export interface ImageResult {
  mimeType: string;
  /** Base64 encoded bytes, sent inline as an MCP image content part. */
  data: string;
  /** Public URL of the same image, sent as a `resource_link`. */
  url: string;
  creditsUsed: number;
}

export type VideoStatus = "queued" | "processing" | "completed" | "failed";

export interface VideoJob {
  id: string;
  status: VideoStatus;
  /** 0 to 100. */
  progress: number;
  prompt: string;
  durationSeconds: number;
  aspectRatio: AspectRatio;
  creditsUsed: number;
  estimatedSeconds: number;
  videoUrl?: string;
  posterUrl?: string;
  error?: string;
}

export class InsufficientCreditsError extends Error {
  readonly needed: number;
  readonly available: number;

  constructor(needed: number, available: number) {
    super(`This needs ${needed} credits and the account has ${available}.`);
    this.name = "InsufficientCreditsError";
    this.needed = needed;
    this.available = available;
  }
}

/** A public sample clip (CC0). The demo backend returns it for every finished "video". */
export const SAMPLE_VIDEO_URL = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

export const CREDITS_PER_IMAGE = 1;
export const CREDITS_PER_VIDEO_SECOND = 2;
const STARTING_CREDITS = 200;

export interface DemoBackendOptions {
  /** Public base URL used to build file links, for example `http://localhost:8787`. */
  baseUrl: string;
  /** How long a fake video job takes. Default 6000 ms. */
  videoDelayMs?: number;
  now?: () => number;
}

interface StoredJob {
  job: Omit<VideoJob, "status" | "progress" | "videoUrl" | "posterUrl">;
  userId: string;
  createdAt: number;
}

/**
 * In-memory backend with no external calls. Images are deterministic SVGs
 * derived from the prompt. Videos are jobs that report `queued`, `processing`
 * and finally `completed` with a fixed sample clip, based on elapsed time.
 */
export class DemoBackend implements GenerationBackend {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly spent = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  private readonly delayMs: number;
  private readonly now: () => number;
  private readonly options: DemoBackendOptions;

  constructor(options: DemoBackendOptions) {
    this.options = options;
    this.delayMs = options.videoDelayMs ?? 6000;
    this.now = options.now ?? Date.now;
  }

  imageUrl(prompt: string, aspectRatio: AspectRatio): string {
    return `${this.options.baseUrl}/files/image.svg?${new URLSearchParams({ p: prompt, ar: aspectRatio })}`;
  }

  private charge(userId: string, credits: number): void {
    const available = STARTING_CREDITS - (this.spent.get(userId) ?? 0);
    if (credits > available) throw new InsufficientCreditsError(credits, available);
    this.spent.set(userId, (this.spent.get(userId) ?? 0) + credits);
    this.counts.set(userId, (this.counts.get(userId) ?? 0) + 1);
  }

  async generateImage(userId: string, input: { prompt: string; aspectRatio: AspectRatio }): Promise<ImageResult> {
    this.charge(userId, CREDITS_PER_IMAGE);
    const svg = renderImageSvg(input.prompt, input.aspectRatio);
    return {
      mimeType: "image/svg+xml",
      data: Buffer.from(svg, "utf8").toString("base64"),
      url: this.imageUrl(input.prompt, input.aspectRatio),
      creditsUsed: CREDITS_PER_IMAGE,
    };
  }

  async startVideo(userId: string, input: { prompt: string; durationSeconds: number; aspectRatio: AspectRatio }): Promise<VideoJob> {
    const creditsUsed = input.durationSeconds * CREDITS_PER_VIDEO_SECOND;
    this.charge(userId, creditsUsed);
    const id = `gen_${randomBytes(9).toString("hex")}`;
    this.jobs.set(id, {
      userId,
      createdAt: this.now(),
      job: { id, prompt: input.prompt, durationSeconds: input.durationSeconds, aspectRatio: input.aspectRatio, creditsUsed, estimatedSeconds: Math.ceil(this.delayMs / 1000) },
    });
    return this.view(this.jobs.get(id)!);
  }

  async getVideo(userId: string, id: string): Promise<VideoJob | null> {
    const stored = this.jobs.get(id);
    // Another user's job looks the same as a missing one.
    if (!stored || stored.userId !== userId) return null;
    return this.view(stored);
  }

  async getAccount(userId: string): Promise<{ credits: number; generations: number }> {
    return { credits: STARTING_CREDITS - (this.spent.get(userId) ?? 0), generations: this.counts.get(userId) ?? 0 };
  }

  private view(stored: StoredJob): VideoJob {
    const elapsed = this.now() - stored.createdAt;
    if (elapsed >= this.delayMs) {
      return {
        ...stored.job,
        status: "completed",
        progress: 100,
        videoUrl: SAMPLE_VIDEO_URL,
        posterUrl: this.imageUrl(stored.job.prompt, stored.job.aspectRatio),
      };
    }
    const progress = Math.floor((elapsed / this.delayMs) * 100);
    return { ...stored.job, status: elapsed < this.delayMs * 0.2 ? "queued" : "processing", progress };
  }
}
