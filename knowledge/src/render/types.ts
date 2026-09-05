import type { z } from "zod";
import type { EnvironmentPinSchema } from "../model.js";

export type EnvironmentPin = z.infer<typeof EnvironmentPinSchema>;
