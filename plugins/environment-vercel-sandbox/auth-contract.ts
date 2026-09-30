import { z } from "zod";
import { scopeSchema } from "./configuration.js";
export const connectionInputSchema = z
  .object({
    hostId: z.string().min(1).max(200),
    directory: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          /^(\/|[A-Za-z]:[\\/])/.test(value) && !/[\r\n\0]/.test(value),
        "Choose an absolute linked directory.",
      ),
  })
  .strict();
export const accountConnectInputSchema = connectionInputSchema
  .extend({ adoptLegacyAllocations: z.boolean().default(false) })
  .strict();
export const connectionSchema = scopeSchema
  .extend({
    ...connectionInputSchema.shape,
    accountId: z.string().min(1).max(200),
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;
export const accountInspectionSchema = z
  .object({
    available: z.boolean(),
    legacyAllocations: scopeSchema
      .extend({ count: z.number().int().positive() })
      .strict()
      .nullable(),
    adoptedAllocations: z.number().int().nonnegative(),
    message: z.string(),
    hostId: z.string().nullable(),
    directory: z.string().nullable(),
    accountId: z.string().nullable(),
    teamId: z.string().nullable(),
    projectId: z.string().nullable(),
  })
  .strict();
