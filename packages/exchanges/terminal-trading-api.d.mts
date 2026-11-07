import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
export function registerTrading(app: FastifyInstance, authorize: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void;
