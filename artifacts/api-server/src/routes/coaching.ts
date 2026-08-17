import { Router, type IRouter } from "express";
import { AnalyzeSetResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const feedbacks = [
  "Perfect tempo!",
  "Too fast on the way down.",
  "Struggling, rack it.",
] as const;

router.get("/", (_req, res) => {
  const sparkdenConfigured = Boolean(
    process.env["VELOCITY_CLIENT_ID"] &&
      process.env["VELOCITY_CLIENT_SECRET"],
  );

  const message = sparkdenConfigured
    ? "Freelocity API is live! Sparkden connection is configured."
    : "Freelocity API is live! Sparkden keys are missing.";

  res.type("text/plain").send(message);
});

router.post("/analyze-set", (_req, res) => {
  const aiFeedback = feedbacks[Math.floor(Math.random() * feedbacks.length)];
  const data = AnalyzeSetResponse.parse({
    status: "success",
    ai_feedback: aiFeedback,
  });

  res.json(data);
});

export default router;