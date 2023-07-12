import { log } from '../logging';
import { createClient } from 'redis';

let lastRedisKeepaliveValue: string;
let redisAlive = false;
let redisReadyResolver: Function;
let ready = new Promise((resolve) => (redisReadyResolver = resolve));

const redis = createClient({
  socket: {
    host: '127.0.0.1',
    port: 6379,
  },
});

redis.on('error', (err) => log('REDIS CLIENT ERROR', err.message));
redis.on('ready', () => {
  log('REDIS INITIALIZED');
  redis.del('keepalive');
  redisReadyResolver();
});

const connect = redis.connect();

const redisKeepaliveWriter = async () =>
  await redis.set('keepalive', String(new Date()));

const redisKeepaliveReader = async () => {
  const keepaliveValue = await redis.get('keepalive');
  if (keepaliveValue && keepaliveValue !== lastRedisKeepaliveValue) {
    lastRedisKeepaliveValue = keepaliveValue;
    if (!redisAlive) {
      log('REDIS CONFIRMED TO BE ALIVE AND KICKING (READY)');
      redisAlive = true;
    }
  } else {
    log('REDIS KEEPALIVE ERROR', { keepaliveValue, lastRedisKeepaliveValue });
    redisAlive = false;
  }
  if (keepaliveValue) {
    lastRedisKeepaliveValue = keepaliveValue;
  }
};

setInterval(redisKeepaliveWriter, 1_000);
setInterval(redisKeepaliveReader, 5_000);

export { redis, ready };

/**
 * Force instant start
 */
connect.then((_) => redisKeepaliveWriter()).then((_) => redisKeepaliveReader());
