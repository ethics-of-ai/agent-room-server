import type { FastifyReply } from "fastify";

/** A refusal that carries the HTTP status it means and, for child-thread and Git refusals, a machine-readable code. */
export interface CodedRefusal {
  message: string;
  statusCode: number;
  code?: string;
}

/** Sends `{ error, code? }` with the refusal's status; every route that passes a refusal's code on goes through here. */
export function sendRefusal(reply: FastifyReply, refusal: CodedRefusal): FastifyReply {
  return reply.code(refusal.statusCode).send({ error: refusal.message, ...(refusal.code ? { code: refusal.code } : {}) });
}
