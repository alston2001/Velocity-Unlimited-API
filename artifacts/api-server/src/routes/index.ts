import { Router, type IRouter } from "express";
import healthRouter from "./health";
import coachingRouter from "./coaching";
import diaryRouter from "./diary";

const router: IRouter = Router();

router.use(healthRouter);
router.use(coachingRouter);
router.use(diaryRouter);

export default router;
