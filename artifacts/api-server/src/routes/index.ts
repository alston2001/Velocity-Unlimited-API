import { Router, type IRouter } from "express";
import healthRouter from "./health";
import coachingRouter from "./coaching";

const router: IRouter = Router();

router.use(healthRouter);
router.use(coachingRouter);

export default router;
