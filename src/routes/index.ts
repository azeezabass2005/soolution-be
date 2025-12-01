import { Router } from 'express';
import protectedRouter from './protected';
import publicRouter from './public';

const router = Router();

router.use(protectedRouter);

router.use(publicRouter);

export default router;