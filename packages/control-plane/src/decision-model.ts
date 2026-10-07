export type SystemOneQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface BoundedDecisionRequest {
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
}

export type SystemOneAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      legend: Record<string, unknown>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface BoundedDecisionResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface DecisionModelRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export type SystemOneModel = "clef" | "clef-flash";

const SYSTEM_ONE_MODEL_IDS: Record<SystemOneModel, string> = {
  clef: "@cf/cloudflare/clef",
  "clef-flash": "@cf/cloudflare/clef-flash",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateQuestionId(id: string): void {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(id)) throw new Error("invalid_decision_question_id");
}

function validateQuestions(questions: Record<string, SystemOneQuestion>): void {
  const entries = Object.entries(questions);
  if (entries.length < 1 || entries.length > 64) throw new Error("invalid_decision_question_count");

  for (const [id, question] of entries) {
    validateQuestionId(id);
    if (!question.instructions.trim()) throw new Error("invalid_decision_instructions");

    if (question.type === "choice") {
      const criteria = Object.entries(question.criteria);
      if (criteria.length < 2 || criteria.length > 255) {
        throw new Error("invalid_decision_choice_criteria");
      }
      for (const [key, description] of criteria) {
        validateQuestionId(key);
        if (!description.trim()) throw new Error("invalid_decision_choice_criteria");
      }
    }

    if (question.type === "score") {
      if (question.criteria.length < 2 || question.criteria.length > 10) {
        throw new Error("invalid_decision_score_criteria");
      }
      if (question.criteria.some((criterion) => !criterion.trim())) {
        throw new Error("invalid_decision_score_criteria");
      }
    }
  }
}

function parseProbabilityMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) throw new Error("invalid_decision_probabilities");

  const probabilities: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    if (!isProbability(probability)) throw new Error("invalid_decision_probabilities");
    probabilities[key] = probability;
  }

  if (Object.keys(probabilities).length < 1) throw new Error("invalid_decision_probabilities");
  return probabilities;
}

function parseAnswer(value: unknown, question: SystemOneQuestion): SystemOneAnswer {
  if (!isRecord(value) || value.type !== question.type) {
    throw new Error("invalid_decision_answer_type");
  }

  if (question.type === "noul") {
    if (!isProbability(value.noul)) throw new Error("invalid_decision_noul_answer");
    return { type: "noul", noul: value.noul };
  }

  if (question.type === "choice") {
    if (typeof value.choice !== "string" || !(value.choice in question.criteria)) {
      throw new Error("invalid_decision_choice_answer");
    }
    if (!isProbability(value.confidence)) throw new Error("invalid_decision_choice_answer");

    const probabilities = parseProbabilityMap(value.probabilities);
    for (const key of Object.keys(probabilities)) {
      if (!(key in question.criteria)) throw new Error("invalid_decision_choice_answer");
    }

    return {
      type: "choice",
      choice: value.choice,
      probabilities,
      confidence: value.confidence,
    };
  }

  if (
    typeof value.score !== "number"
    || !Number.isFinite(value.score)
    || value.score < 0
    || value.score > question.criteria.length - 1
    || !isRecord(value.legend)
    || !isProbability(value.confidence)
  ) {
    throw new Error("invalid_decision_score_answer");
  }

  return {
    type: "score",
    score: value.score,
    legend: value.legend,
    probabilities: parseProbabilityMap(value.probabilities),
    confidence: value.confidence,
  };
}

function parseResponse(value: unknown, request: BoundedDecisionRequest): BoundedDecisionResponse {
  if (
    !isRecord(value)
    || typeof value.model !== "string"
    || !isRecord(value.answers)
    || !isRecord(value.usage)
  ) {
    throw new Error("invalid_decision_model_response");
  }

  if (
    typeof value.usage.input_tokens !== "number"
    || !Number.isInteger(value.usage.input_tokens)
    || value.usage.input_tokens < 0
    || typeof value.usage.output_tokens !== "number"
    || !Number.isInteger(value.usage.output_tokens)
    || value.usage.output_tokens < 0
  ) {
    throw new Error("invalid_decision_usage");
  }

  const answers: Record<string, SystemOneAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (!(id in value.answers)) throw new Error("incomplete_decision_model_response");
    answers[id] = parseAnswer(value.answers[id], question);
  }

  return {
    model: value.model,
    answers,
    usage: {
      input_tokens: value.usage.input_tokens,
      output_tokens: value.usage.output_tokens,
    },
  };
}

/**
 * Adapter for System One decision-model APIs such as Cloudflare Clef/Clef-flash
 * and Jev-compatible providers.
 *
 * This layer is deliberately advisory. It returns typed bounded decisions but
 * never dispatches an operation, grants authority, acquires a resource, or
 * mutates policy. The caller must apply deterministic CommandHarbor policy.
 */
export class SystemOneDecisionProvider {
  readonly model: SystemOneModel;

  constructor(
    private readonly runner: DecisionModelRunner,
    model: SystemOneModel = "clef-flash",
  ) {
    this.model = model;
  }

  async evaluate(request: BoundedDecisionRequest): Promise<BoundedDecisionResponse> {
    validateQuestions(request.questions);

    const value = await this.runner.run(SYSTEM_ONE_MODEL_IDS[this.model], {
      model: this.model,
      state: request.state,
      questions: request.questions,
    });

    return parseResponse(value, request);
  }
}

export interface DeterministicDecisionRule<TContext, TDecision> {
  id: string;
  evaluate(context: TContext): TDecision | undefined;
}

export type DecisionResolution<TDecision> =
  | { source: "deterministic"; decision: TDecision; ruleId: string }
  | { source: "bounded_model"; response: BoundedDecisionResponse }
  | { source: "escalate"; reason: "bounded_model_unavailable" };

/**
 * CommandHarbor decision hierarchy:
 * deterministic rule -> optional bounded decision model -> explicit escalation.
 *
 * Frontier reasoning and human approval intentionally sit outside this helper;
 * they are higher-cost / higher-authority escalation layers and must be called
 * explicitly by the future task arbiter.
 */
export async function resolveDecision<TContext, TDecision>(
  context: TContext,
  rules: readonly DeterministicDecisionRule<TContext, TDecision>[],
  bounded:
    | { provider: SystemOneDecisionProvider; request: BoundedDecisionRequest }
    | undefined,
): Promise<DecisionResolution<TDecision>> {
  for (const rule of rules) {
    const decision = rule.evaluate(context);
    if (decision !== undefined) {
      return { source: "deterministic", decision, ruleId: rule.id };
    }
  }

  if (!bounded) return { source: "escalate", reason: "bounded_model_unavailable" };

  return {
    source: "bounded_model",
    response: await bounded.provider.evaluate(bounded.request),
  };
}
