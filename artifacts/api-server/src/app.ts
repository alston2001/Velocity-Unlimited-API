import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { randomUUID } from "node:crypto";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    genReqId(req, res) {
      const incoming = req.headers["x-request-id"];
      const id = typeof incoming === "string" && incoming.length <= 128 ? incoming : randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));

app.use("/api", router);
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof error === "object" && error !== null && "type" in error && (error as { type?: string }).type === "entity.too.large"
    ? 413
    : 400;
  req.log.warn({ error, status }, "Request rejected");
  res.status(status).json({
    status: "error",
    code: status === 413 ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST",
    request_id: req.id,
  });
});

export default app;
