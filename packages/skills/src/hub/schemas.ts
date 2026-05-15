import { z } from "zod";

const SkillSourceIdSchema = z.enum(["github", "url", "claude-marketplace"]);
const TrustLevelSchema = z.enum(["trusted", "community"]);

const ContentHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{16}$/, "must be sha256:<16-hex>");

const RepoSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be owner/repo");

export const HubLockEntrySchema = z.object({
  version: z.string().max(50).optional(),
  contentHash: ContentHashSchema,
  source: SkillSourceIdSchema,
  identifier: z.string().min(1).max(512),
  resolvedRef: z.string().max(512).optional(),
  trustLevel: TrustLevelSchema,
  installedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  files: z.array(z.string().max(512)).max(200),
});

export const HubLockFileSchema = z.object({
  version: z.literal(1),
  installed: z.record(z.string(), HubLockEntrySchema),
});

export const TapSchema = z.object({
  source: z.enum(["github", "claude-marketplace"]),
  repo: RepoSchema,
  path: z.string().min(1).max(256).default("skills/"),
  addedAt: z.string().datetime(),
});

export const TapsFileSchema = z.object({
  version: z.literal(1),
  taps: z.array(TapSchema),
});

export const AuditActionSchema = z.enum([
  "INSTALL",
  "INSTALL_FAILED",
  "UPDATE",
  "UPDATE_FAILED",
  "UNINSTALL",
  "UNINSTALL_FAILED",
  "TAP_ADD",
  "TAP_REMOVE",
]);

export const AuditRowSchema = z.object({
  ts: z.string().datetime(),
  action: AuditActionSchema,
  name: z.string().optional(),
  source: SkillSourceIdSchema.optional(),
  identifier: z.string().optional(),
  trustLevel: TrustLevelSchema.optional(),
  contentHash: z.string().optional(),
  oldHash: z.string().optional(),
  newHash: z.string().optional(),
  repo: z.string().optional(),
  outcome: z.enum(["ok", "error"]),
  reason: z.string().optional(),
});
