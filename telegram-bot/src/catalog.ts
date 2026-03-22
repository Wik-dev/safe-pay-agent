/**
 * Catalog-driven tool generation. Loads catalog JSON at startup,
 * generates Claude tool definitions, keyword patterns, system prompts,
 * and display formatting — all dynamically from catalog data.
 */

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import type { ResultRecord } from "./store.js";

export interface DisplayConfig {
  title: string;
  result_title: string;
  param_labels: Record<string, string>;
  result_labels: Record<string, string>;
  context_fields: string[];
  context_status_field?: string;
  context_active_value?: string;
}

export interface TemplateEntry {
  description: string;
  parameter_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  approval_tier: string;
  keywords?: string[];
  display?: DisplayConfig;
  [key: string]: unknown;
}

export interface CatalogData {
  templates: Record<string, TemplateEntry>;
  keywords_global?: string[];
  keyword_patterns?: string[];
  images?: Record<string, string>;
}

export class Catalog {
  readonly data: CatalogData;

  private constructor(data: CatalogData) {
    this.data = data;
  }

  static load(path?: string): Catalog {
    const catalogPath =
      path ?? process.env.CATALOG_PATH ?? new URL("../../catalog/ton-payments.json", import.meta.url).pathname;
    const raw = readFileSync(catalogPath, "utf-8");
    return new Catalog(JSON.parse(raw) as CatalogData);
  }

  /** Get a template by action name. */
  template(action: string): TemplateEntry | undefined {
    return this.data.templates[action];
  }

  /** All template action names. */
  get actions(): string[] {
    return Object.keys(this.data.templates);
  }

  /** Generate Claude tool definitions from catalog templates. */
  buildTools(): Anthropic.Messages.Tool[] {
    return Object.entries(this.data.templates).map(([name, tpl]) => ({
      name,
      description: tpl.description,
      input_schema: {
        type: "object" as const,
        properties: tpl.parameter_schema.properties,
        required: tpl.parameter_schema.required,
      },
    }));
  }

  /** Build system prompt with dynamic action list + active result context. */
  buildSystemPrompt(activeResults: ResultRecord[]): string {
    const actionList = Object.entries(this.data.templates)
      .map(([name, tpl]) => `- ${name}: ${tpl.description}`)
      .join("\n");

    let resultContext = "";
    if (activeResults.length > 0) {
      const lines = activeResults.map((r, i) => {
        const display = this.data.templates[r.action]?.display;
        const fields = display?.context_fields ?? Object.keys(r.output);
        const parts = fields
          .filter((f) => r.output[f] !== undefined)
          .map((f) => {
            const label = display?.param_labels?.[f] ?? display?.result_labels?.[f] ?? humanize(f);
            return `${label}: ${r.output[f]}`;
          });
        return `${i + 1}. [${r.action}] ${parts.join(" | ")}`;
      });
      resultContext = `\n\nActive results:\n${lines.join("\n")}\n\nWhen the user refers to an item by description, match it to the correct entry above.`;
    }

    return `You are Safe Pay Agent, an AI assistant in a Telegram chat.

Available actions:
${actionList}

Rules:
- Only call tools when the user has a clear intent with enough information.
- If required parameters are missing, ask for them conversationally.
- When the user requests multiple actions in a single message, call all the corresponding tools in parallel in one response. Do not batch them into a single call or ask for confirmation — emit one tool_use block per action.
- For actions that reference previous results, use the active results list to resolve descriptions.
- If the message is ambiguous or just a question, respond conversationally without calling any tool.
- Keep responses brief and friendly.${resultContext}`;
  }

  /** Compile keyword regex from per-template keywords + global patterns. */
  buildKeywordPattern(): RegExp {
    const parts: string[] = [];

    // Per-template keywords (escaped, case-insensitive word match)
    for (const tpl of Object.values(this.data.templates)) {
      if (tpl.keywords) {
        for (const kw of tpl.keywords) {
          parts.push(escapeRegex(kw));
        }
      }
    }

    // Global keywords
    if (this.data.keywords_global) {
      for (const kw of this.data.keywords_global) {
        parts.push(escapeRegex(kw));
      }
    }

    // Raw regex patterns (e.g., TON address format)
    if (this.data.keyword_patterns) {
      for (const pat of this.data.keyword_patterns) {
        parts.push(pat);
      }
    }

    return new RegExp(parts.join("|"), "i");
  }

  /** Build human-readable summary for a tool call. */
  formatSummary(action: string, params: Record<string, unknown>): string {
    const display = this.data.templates[action]?.display;
    if (!display) {
      return `${humanize(action)}: ${JSON.stringify(params)}`;
    }

    const parts = Object.entries(params).map(([key, val]) => {
      const label = display.param_labels[key] ?? humanize(key);
      return `${label}: ${val}`;
    });

    return `${display.title}\n${parts.join(" | ")}`;
  }
}

/** Convert snake_case to Title Case. */
export function humanize(key: string): string {
  return key
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
