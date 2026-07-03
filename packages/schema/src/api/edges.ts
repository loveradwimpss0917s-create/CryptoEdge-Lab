// Public API request schemas for the Edge resource (docs/08 "Edges / Versions / Runs").

import { z } from "zod";
import { EDGE_CATEGORIES, EDGE_DIRECTIONS, EDGE_ORIGINS, EDGE_STATUSES } from "../db/enums.js";
import { signalSpecSchema } from "../domain/dsl.js";

export const evidenceItemSchema = z.object({
  kind: z.enum(["paper", "blog", "internal"]),
  ref: z.string().min(1),
  note: z.string().optional()
});

export const createEdgeRequestSchema = z.object({
  title: z.string().min(1),
  category: z.enum(EDGE_CATEGORIES),
  hypothesis: z.string().min(1),
  rationale: z.string().min(1),
  counter_evidence: z.string().optional(),
  evidence: z.array(evidenceItemSchema).optional(),
  origin: z.enum(EDGE_ORIGINS),
  pdf_ref: z.string().optional(),
  priors: z.record(z.string(), z.number()).optional(),
  finding_id: z.string().optional()
});
export type CreateEdgeRequest = z.infer<typeof createEdgeRequestSchema>;

export const createEdgeVersionRequestSchema = z.object({
  semver: z.string().regex(/^\d+\.\d+\.\d+$/),
  signal_spec: signalSpecSchema,
  params: z.record(z.string(), z.unknown()),
  instrument_id: z.string().min(1),
  direction: z.enum(EDGE_DIRECTIONS),
  horizon: z.string().min(1),
  entry_universe: z.record(z.string(), z.unknown()).optional(),
  cost_model: z.object({
    taker_bps: z.number().min(0),
    slippage_bps: z.number().min(0),
    funding_included: z.boolean()
  }),
  changelog: z.string().optional()
});
export type CreateEdgeVersionRequest = z.infer<typeof createEdgeVersionRequestSchema>;

export const transitionEdgeRequestSchema = z.object({
  to_status: z.enum(EDGE_STATUSES),
  reason: z.string().min(1)
});
export type TransitionEdgeRequest = z.infer<typeof transitionEdgeRequestSchema>;

// docs/08 POST /edges/{id}/eval. `kind=screen` is the cheap CANDIDATE->TESTING
// gate check (docs/05 §2); `kind=full` is the complete EEP run TESTING->VALIDATED
// needs.
export const evalEdgeRequestSchema = z.object({
  version_id: z.string().min(1),
  kind: z.enum(["screen", "full"])
});
export type EvalEdgeRequest = z.infer<typeof evalEdgeRequestSchema>;

export const listEdgesQuerySchema = z.object({
  status: z.enum(EDGE_STATUSES).optional(),
  category: z.enum(EDGE_CATEGORIES).optional(),
  q: z.string().optional(),
  sort: z.enum(["score", "created_at", "updated_at"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50)
});
export type ListEdgesQuery = z.infer<typeof listEdgesQuerySchema>;
