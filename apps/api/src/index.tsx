import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { unknown, z } from "zod";
import crypto from "crypto";

const log = pino({ transport: { target: "pino-pretty" } });
const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(pinoHttp({ logger: log }));

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

// helpers
function stableHash(input: string) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function pickVariantByWeight(
  variants: { key: string; weight: number }[],
  bucket: number
) {
  let acc = 0;
  for (const v of variants) {
    acc += v.weight;
    if (bucket < acc) {
      return v.key;
    }
  }
  return variants[variants.length - 1]?.key;
}

function contextMatchesClause(ctx: Record<string, any>, clause: string) {
  // super-simple matcher: "country==US && plan==pro"
  return clause.split("&&").every(part => {
    const [k, val] = part.trim().split("==");
    return String(ctx[k.trim()]) === String(val?.trim());
  })
}

async function evaluateFlag(projectId: string, envKey: string, flagKey: string, ctx: Record<string, any>) {
  const cacheKey = `sdk:${projectId}:${envKey}:${flagKey}`;
  const cached = await redis.get(cacheKey);
  let flag;
  if (cached) {
    flag = JSON.parse(cached);
  } else {
    flag = await prisma.flag.findFirst({
      where: {projectId, key: flagKey },
      include: { variants: true, rules: { orderBy: { priority: "asc" } } }
    });
    if (flag) {
      await redis.set(cacheKey, JSON.stringify(flag), "EX", 15);
    }
  }
  if (!flag) {
    return { enabled: false };
  }

  const matchFule = flag.rules.find(r => contextMatchesClause(ctx, r.clause));
  const variants = flag.variants.map(v => ({ key: v.key, weight: v.weight }));
  const seed = `${flag.key}:${ctx.userId ?? "anon"}`;
  const bucket = parseInt(stableHash(seed).slice(0, 4), 16) % 10000;

  // if a rule matched, you could override variant weights (not shown here).
  const chosen = pickVariantByWeight(variants, bucket);
  return { enabled: true, variant: chosen };
}

// routes
app.get("/healthz", (_, res) => res.send("ok"));

const evalBody = z.object({
  projectId: z.string(),
  environment: z.string(),
  flagKey: z.string(),
  context: z.record(z.any(), z.unknown()).default({})
});

app.post("/api/v1/evaluate", async (req, res) => {
  const parsed = evalBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(parsed.error.format());
  }
  const { projectId, environment, flagKey, context } = parsed.data;
  const result = await evaluateFlag(projectId, environment, flagKey, context);
  res.json(result);
});