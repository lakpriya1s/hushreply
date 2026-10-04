import raw from "../rules.json";
import { resolve, type ResolvedRule } from "./rules";
import type { RuleConfig } from "./types";

/** Rules with defaults folded in and disabled ones dropped. Built once per isolate. */
export const RULES: ResolvedRule[] = resolve(raw as RuleConfig);
