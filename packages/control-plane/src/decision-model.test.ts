import { describe, expect, it, vi } from "vitest";
import {
  resolveDecision,
  SystemOneDecisionProvider,
  type DecisionModelRunner,
} from "./decision-model";

describe("SystemOneDecisionProvider", () => {
  it("maps a bounded request to the Clef-flash System One contract", async () => {
    const run = vi.fn(async () => ({
      model: "clef-flash",
      answers: {
        strategy: {
          type: "choice",
          choice: "deterministic",
          probabilities: { deterministic: 0.98, pixels: 0.02 },
          confidence: 0.96,
        },
        approval: { type: "noul", noul: 0.04 },
      },
      usage: { input_tokens: 12, output_tokens: 7 },
    }));
    const provider = new SystemOneDecisionProvider({ run } satisfies DecisionModelRunner);

    const response = await provider.evaluate({
      state: { task: "read a local file" },
      questions: {
        strategy: {
          type: "choice",
          instructions: "Which mechanism should handle this task?",
          criteria: {
            deterministic: "Native filesystem read",
            pixels: "Visual pixel control",
          },
        },
        approval: {
          type: "noul",
          instructions: "Does this bounded read require human approval?",
        },
      },
    });

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("@cf/cloudflare/clef-flash", {
      model: "clef-flash",
      state: { task: "read a local file" },
      questions: expect.any(Object),
    });
    expect(response.model).toBe("clef-flash");
    expect(response.answers.strategy).toEqual({
      type: "choice",
      choice: "deterministic",
      probabilities: { deterministic: 0.98, pixels: 0.02 },
      confidence: 0.96,
    });
    expect(response.answers.approval).toEqual({ type: "noul", noul: 0.04 });
    expect(response.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  it("fails closed on incomplete model output", async () => {
    const provider = new SystemOneDecisionProvider({
      run: async () => ({
        model: "clef-flash",
        answers: {},
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });

    await expect(provider.evaluate({
      state: "state",
      questions: {
        route: {
          type: "choice",
          instructions: "Pick one.",
          criteria: { local: "local", remote: "remote" },
        },
      },
    })).rejects.toThrow("incomplete_decision_model_response");
  });

  it("fails closed when a provider returns the wrong answer shape", async () => {
    const provider = new SystemOneDecisionProvider({
      run: async () => ({
        model: "clef-flash",
        answers: {
          route: { type: "noul", noul: 0.8 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });

    await expect(provider.evaluate({
      state: "state",
      questions: {
        route: {
          type: "choice",
          instructions: "Pick one.",
          criteria: { local: "local", remote: "remote" },
        },
      },
    })).rejects.toThrow("invalid_decision_answer_type");
  });

  it("requires provider usage accounting from the System One response", async () => {
    const provider = new SystemOneDecisionProvider({
      run: async () => ({
        model: "clef-flash",
        answers: { approval: { type: "noul", noul: 0.2 } },
      }),
    });

    await expect(provider.evaluate({
      state: "state",
      questions: {
        approval: { type: "noul", instructions: "Approve?" },
      },
    })).rejects.toThrow("invalid_decision_model_response");
  });

  it("rejects malformed question contracts before invoking a model", async () => {
    const run = vi.fn(async () => ({
      model: "clef-flash",
      answers: {},
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = new SystemOneDecisionProvider({ run });

    await expect(provider.evaluate({
      state: "state",
      questions: {
        "bad id with spaces": {
          type: "noul",
          instructions: "Question?",
        },
      },
    })).rejects.toThrow("invalid_decision_question_id");

    expect(run).not.toHaveBeenCalled();
  });
});

describe("resolveDecision", () => {
  it("keeps deterministic policy ahead of probabilistic decisions", async () => {
    const run = vi.fn(async () => ({
      model: "clef-flash",
      answers: { route: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = new SystemOneDecisionProvider({ run });

    const result = await resolveDecision(
      { readOnly: true },
      [
        {
          id: "native-read",
          evaluate: (context: { readOnly: boolean }) =>
            context.readOnly ? "native_filesystem" : undefined,
        },
      ],
      {
        provider,
        request: {
          state: "unused",
          questions: {
            route: { type: "noul", instructions: "Use the model?" },
          },
        },
      },
    );

    expect(result).toEqual({
      source: "deterministic",
      decision: "native_filesystem",
      ruleId: "native-read",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("falls through to the bounded model only when deterministic rules do not decide", async () => {
    const provider = new SystemOneDecisionProvider({
      run: async () => ({
        model: "clef",
        answers: { route: { type: "noul", noul: 0.81 } },
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
    }, "clef");

    const result = await resolveDecision(
      { ambiguous: true },
      [{ id: "known-safe", evaluate: () => undefined }],
      {
        provider,
        request: {
          state: { ambiguous: true },
          questions: {
            route: { type: "noul", instructions: "Is local execution preferred?" },
          },
        },
      },
    );

    expect(result.source).toBe("bounded_model");
    if (result.source === "bounded_model") {
      expect(result.response.model).toBe("clef");
      expect(result.response.answers.route).toEqual({ type: "noul", noul: 0.81 });
    }
  });

  it("escalates instead of inventing a decision when no bounded model is configured", async () => {
    await expect(resolveDecision(
      { ambiguous: true },
      [{ id: "known-safe", evaluate: () => undefined }],
      undefined,
    )).resolves.toEqual({
      source: "escalate",
      reason: "bounded_model_unavailable",
    });
  });
});
