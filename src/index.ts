import { ready as redisReady } from './redis';
import { connectUplinks } from './upstream';
// import RollingLimit from 'redis-token-bucket-ratelimiter';

await redisReady;
connectUplinks();
